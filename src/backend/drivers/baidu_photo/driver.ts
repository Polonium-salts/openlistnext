// BaiduPhoto (一刻相册) driver
// Re-ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/baidu_photo
// (driver.go)
import {
  calcFileType,
  type FileItem,
  type StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import {
  BaiduPhotoClient,
  computeSliceInfo,
  encryptMd5,
  getFileName,
  uploadFileToFile,
} from "./util"
import type { Album, AlbumFile, BaiduPhotoAddition, File } from "./types"

const DEFAULT_SLICE = 1 << 22 // 4MB
const SLICE_MD5_SIZE = 1 << 18 // 256KB

type ObjKind = "root" | "album" | "file" | "albumfile"

interface CachedObj {
  kind: ObjKind
  album?: Album
  file?: File
  albumFile?: AlbumFile
}

function basename(p: string): string {
  const segs = String(p || "").split("/")
  return segs[segs.length - 1] || ""
}

function toFileItem(file: File): FileItem {
  const name = getFileName(file.path)
  return {
    name,
    size: file.size || 0,
    is_dir: false,
    created: file.ctime ? new Date(file.ctime * 1000).toISOString() : undefined,
    modified: file.mtime
      ? new Date(file.mtime * 1000).toISOString()
      : new Date().toISOString(),
    sign: String(file.fsid),
    type: calcFileType(name, false),
    thumb: file.thumburl?.[0] || "",
    raw_url: "",
  }
}

function toAlbumItem(album: Album): FileItem {
  return {
    name: album.title,
    size: 0,
    is_dir: true,
    created: album.create_time
      ? new Date(album.create_time * 1000).toISOString()
      : undefined,
    modified: album.mtime
      ? new Date(album.mtime * 1000).toISOString()
      : new Date().toISOString(),
    sign: album.album_id,
    type: 1,
    thumb: "",
    raw_url: "",
  }
}

function toAlbumFileItem(file: AlbumFile): FileItem {
  const name = getFileName(file.path)
  return {
    name,
    size: file.size || 0,
    is_dir: false,
    created: file.ctime ? new Date(file.ctime * 1000).toISOString() : undefined,
    modified: file.mtime
      ? new Date(file.mtime * 1000).toISOString()
      : new Date().toISOString(),
    sign: String(file.fsid),
    type: calcFileType(name, false),
    thumb: file.thumburl?.[0] || "",
    raw_url: "",
  }
}

export class BaiduPhotoDriver implements StorageDriver {
  private client!: BaiduPhotoClient
  private addition!: BaiduPhotoAddition
  private root: CachedObj = { kind: "root" }
  /** physicalPath → object cache，用于 move/copy/rename/remove 定位 */
  private cache = new Map<string, CachedObj>()
  /**
   * 相册标题 → Album 反查表。
   * 前端进入子目录时物理路径片段是相册标题（name）而非 album_id，
   * 因此 list/get 需通过标题命中相册。
   */
  private albumByTitle = new Map<string, Album>()

  constructor(addition: BaiduPhotoAddition) {
    this.addition = addition
  }

  async init(): Promise<void> {
    this.client = new BaiduPhotoClient(this.addition)
    const a = this.addition

    // root：若指定 AlbumID 则以该相册为根
    if (a.album_id && a.album_id.trim()) {
      const albumID = a.album_id.split("|")[0]
      const album = await this.client.getAlbumDetail(albumID)
      this.root = { kind: "album", album }
      this.cache.set("/", { kind: "album", album })
      this.albumByTitle.set(album.title, album)
      this.albumByTitle.set(albumID, album)
    } else {
      this.root = { kind: "root" }
    }

    // uk
    const info = await this.client.uInfo()
    this.client.uk = parseInt(info.youa_id, 10) || 0
    this.client.bdstoken = await this.client.getBDStoken()
  }

  private cleanPhysical(physicalPath: string): string {
    let p =
      "/" +
      String(physicalPath || "")
        .replace(/^\/+/, "")
        .replace(/\/+/g, "/")
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1)
    return p
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const phys = this.cleanPhysical(physicalPath)

    // 缓存当前目录
    if (this.cache.has(phys)) {
      const obj = this.cache.get(phys)!
      if (obj.kind === "album" && obj.album) {
        return this.listAlbum(obj.album, phys)
      }
      if (obj.kind === "file" || obj.kind === "albumfile") {
        throw new Error("not a directory")
      }
    }

    // root 或 album 根
    if (phys === "/") {
      if (this.root.kind === "album" && this.root.album) {
        return this.listAlbum(this.root.album, phys)
      }
      return this.listRoot(phys)
    }

    // 通过相册标题反查（前端进入子目录时物理路径片段是相册标题）
    const title = phys.slice(1)
    const album = this.albumByTitle.get(title)
    if (album) {
      this.cache.set(phys, { kind: "album", album })
      return this.listAlbum(album, phys)
    }

    // 兜底：相册列表可能尚未加载，主动拉取一次再匹配
    await this.ensureAlbums()
    const album2 = this.albumByTitle.get(title)
    if (album2) {
      this.cache.set(phys, { kind: "album", album: album2 })
      return this.listAlbum(album2, phys)
    }

    console.error(`[baidu_photo] path not found: ${phys}`)
    throw new Error("baidu_photo: path not found")
  }

  /** 拉取全部相册并填充 albumByTitle / cache，供未预列根目录时反查 */
  private async ensureAlbums(): Promise<void> {
    if (this.albumByTitle.size > 0) return
    if (this.addition.show_type === "root_only_file") return
    const albums = await this.client.getAllAlbum()
    for (const a of albums) {
      this.albumByTitle.set(a.title, a)
      this.cache.set("/" + a.title, { kind: "album", album: a })
      this.cache.set("/" + encodeURIComponent(a.album_id), {
        kind: "album",
        album: a,
      })
    }
  }

  /**
   * get 缓存未命中时，尝试通过相册标题或父相册列出文件来解析对象。
   * 适用于前端直接访问文件 URL（跳过先列目录）的场景。
   */
  /**
   * 把名称做 URL 解码归一化，用于比较前端传来的路径段与百度返回的文件名
   * （两者编码状态可能不一致：一个是 decode 中文，一个是 encode 百分号序列）。
   */
  private normalizeName(s: string): string {
    try {
      // 连续 decode 直到稳定，避免双重编码问题
      let prev = s
      let cur = decodeURIComponent(s)
      let guard = 0
      while (cur !== prev && guard++ < 3) {
        prev = cur
        cur = decodeURIComponent(cur)
      }
      return cur
    } catch {
      return s
    }
  }

  private async resolveByParent(phys: string): Promise<CachedObj | undefined> {
    if (phys === "/") return undefined
    await this.ensureAlbums()

    const idx = phys.lastIndexOf("/")
    const parent = phys.slice(0, idx) || "/"
    const baseName = phys.slice(idx + 1)

    // 1) 整个 phys 本身是相册标题
    const album = this.albumByTitle.get(phys.slice(1))
    if (album) {
      const o: CachedObj = { kind: "album", album }
      this.cache.set(phys, o)
      return o
    }

    // 2) 父目录是相册 -> 列出该相册文件，按归一化名称匹配
    const parentAlbum =
      this.cache.get(parent)?.album || this.albumByTitle.get(parent.slice(1))
    if (parentAlbum) {
      const items = await this.listAlbum(parentAlbum, parent)
      const hit = this.findCachedByName(items, parent, baseName)
      if (hit) return hit
    }

    // 3) 父目录是根（含单相册模式根即某相册）
    if (parent === "/") {
      let items: FileItem[] = []
      if (this.root.kind === "album" && this.root.album) {
        items = await this.listAlbum(this.root.album, "/")
      } else {
        items = await this.listRoot("/")
      }
      const hit = this.findCachedByName(items, "/", baseName)
      if (hit) return hit
    }
    return undefined
  }

  /** 在刚列出的 items 中按归一化名称找到对应的缓存对象 */
  private findCachedByName(
    items: FileItem[],
    parent: string,
    baseName: string,
  ): CachedObj | undefined {
    const target = this.normalizeName(baseName)
    for (const it of items) {
      if (this.normalizeName(it.name) === target) {
        const obj = this.cache.get(parent + "/" + it.name)
        if (obj) return obj
      }
    }
    return undefined
  }

  private async listRoot(phys: string): Promise<FileItem[]> {
    const showType = this.addition.show_type || "root"
    const items: FileItem[] = []
    this.cache.set(phys, { kind: "root" })

    if (showType !== "root_only_file") {
      const albums = await this.client.getAllAlbum()
      for (const album of albums) {
        this.albumByTitle.set(album.title, album)
        const childPhys = phys + "/" + album.title
        this.cache.set(childPhys, { kind: "album", album })
        this.cache.set("/" + encodeURIComponent(album.album_id), {
          kind: "album",
          album,
        })
        items.push(toAlbumItem(album))
      }
    }
    if (showType !== "root_only_album") {
      const files = await this.client.getAllFile()
      for (const file of files) {
        const name = getFileName(file.path)
        const childPhys = phys + "/" + encodeURIComponent(name)
        this.cache.set(childPhys, { kind: "file", file })
        this.cache.set(phys + "/" + name, { kind: "file", file })
        items.push(toFileItem(file))
      }
    }
    return sortFileItems(
      items,
      (this.addition as any).order_by || "name",
      (this.addition as any).order_direction,
    )
  }

  private async listAlbum(album: Album, phys: string): Promise<FileItem[]> {
    const files = await this.client.getAllAlbumFile(album, "")
    const items: FileItem[] = []
    for (const f of files) {
      const name = getFileName(f.path)
      const childPhys = phys + "/" + encodeURIComponent(name)
      this.cache.set(childPhys, { kind: "albumfile", albumFile: f })
      this.cache.set(phys + "/" + name, { kind: "albumfile", albumFile: f })
      items.push(toAlbumFileItem(f))
    }
    return sortFileItems(
      items,
      (this.addition as any).order_by || "name",
      (this.addition as any).order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const phys = this.cleanPhysical(physicalPath)
    if (phys === "/") {
      return {
        name: "/",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    }
    let obj = this.cache.get(phys)
    if (!obj) {
      // 兜底：通过相册标题 / 父相册列出文件来填充缓存
      obj = await this.resolveByParent(phys)
    }
    if (!obj) {
      console.error(
        `[baidu_photo] get: object not in cache for phys=${phys} | ` +
          `root.kind=${this.root.kind} | cache.has(/)=${this.cache.has("/")} | ` +
          `cache.size=${this.cache.size} | albumByTitle.size=${this.albumByTitle.size}`,
      )
      throw new Error(
        `baidu_photo: object not found in cache (try re-listing the folder) | phys=${phys} | root=${this.root.kind} | cacheHasRoot=${this.cache.has("/")} | cacheSize=${this.cache.size}`,
      )
    }

    let item: FileItem
    let linkable: File | AlbumFile | undefined
    if (obj.kind === "album" && obj.album) {
      item = toAlbumItem(obj.album)
      return item
    } else if (obj.kind === "file" && obj.file) {
      item = toFileItem(obj.file)
      linkable = obj.file
    } else if (obj.kind === "albumfile" && obj.albumFile) {
      item = toAlbumFileItem(obj.albumFile)
      linkable = obj.albumFile
    } else {
      throw new Error("baidu_photo: unsupported object kind")
    }

    if (linkable) {
      try {
        const link = await this.client.getLink(linkable, "")
        item.raw_url = link.url
        item.raw_url_headers = link.headers
      } catch (e: any) {
        console.warn(`[baidu_photo] get link warning: ${e.message}`)
        item.raw_url_error = e.message
      }
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const phys = this.cleanPhysical(physicalPath)
    // 仅支持在根目录下创建
    const parent = phys.substring(0, phys.lastIndexOf("/")) || "/"
    if (parent !== "/") {
      throw new Error("make dir is only supported in root")
    }
    const name = basename(phys)
    const joinMatch = /^join:(.*)$/i.exec(name)
    let album: Album
    if (joinMatch) {
      album = await this.client.joinAlbum(joinMatch[1])
    } else {
      album = await this.client.createAlbum(name)
    }
    const childPhys = "/" + album.title
    this.albumByTitle.set(album.title, album)
    this.cache.set(childPhys, { kind: "album", album })
    this.cache.set("/" + encodeURIComponent(album.album_id), {
      kind: "album",
      album,
    })
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const phys = this.cleanPhysical(physicalPath)
    const obj = this.cache.get(phys)
    if (!obj || obj.kind !== "album" || !obj.album) {
      throw new Error("only album rename is supported")
    }
    const updated = await this.client.setAlbumName(obj.album, newName)
    this.cache.set(phys, { kind: "album", album: updated })
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const phys = this.cleanPhysical(physicalPath)
    const obj = this.cache.get(phys)
    if (!obj) {
      console.error(
        `[baidu_photo] get: object not in cache for phys=${phys} | ` +
          `root.kind=${this.root.kind} | cache.has(/)=${this.cache.has("/")} | ` +
          `cache.size=${this.cache.size} | albumByTitle.size=${this.albumByTitle.size}`,
      )
      throw new Error(
        `baidu_photo: object not found in cache (try re-listing the folder) | phys=${phys} | root=${this.root.kind} | cacheHasRoot=${this.cache.has("/")} | cacheSize=${this.cache.size}`,
      )
    }
    if (obj.kind === "file" && obj.file) {
      await this.client.deleteFile(obj.file)
    } else if (obj.kind === "albumfile" && obj.albumFile) {
      await this.client.deleteAlbumFile(obj.albumFile)
    } else if (obj.kind === "album" && obj.album) {
      await this.client.deleteAlbum(obj.album)
    } else {
      throw new Error("not supported")
    }
    this.cache.delete(phys)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const name = names[0] || basename(srcPhys)
    const src = this.cache.get(this.cleanPhysical(srcPhys))
    const dst = this.cache.get(this.cleanPhysical(dstDir))
    if (!src || !dst) throw new Error("move: source or dest not found")
    if (src.kind !== "albumfile" || !src.albumFile) {
      throw new Error("only album file move is supported")
    }
    // albumfile → root/album：复制后删除原文件
    const newObj = await this.copyInternal(src.albumFile, dst)
    await this.client.deleteAlbumFile(src.albumFile)
    const targetPhys =
      this.cleanPhysical(dstPhys) + "/" + encodeURIComponent(name)
    this.cache.set(targetPhys, newObj)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const name = names[0] || basename(srcPhys)
    const src = this.cache.get(this.cleanPhysical(srcPhys))
    const dst = this.cache.get(this.cleanPhysical(dstDir))
    if (!src || !dst) throw new Error("copy: source or dest not found")
    const newObj = await this.copyInternal(
      src.kind === "file"
        ? src.file!
        : src.kind === "albumfile"
          ? src.albumFile!
          : undefined!,
      dst,
    )
    const targetPhys =
      this.cleanPhysical(dstPhys) + "/" + encodeURIComponent(name)
    this.cache.set(targetPhys, newObj)
  }

  private async copyInternal(
    src: File | AlbumFile,
    dst: CachedObj,
  ): Promise<CachedObj> {
    if (!src) throw new Error("copy: unsupported source")
    if (dst.kind === "album" && dst.album) {
      if ("album_id" in src) {
        // albumfile → root → album
        const rootFile = await this.client.copyAlbumFile(src as AlbumFile)
        const af = await this.client.addAlbumFile(dst.album, rootFile)
        return { kind: "albumfile", albumFile: af }
      }
      // file → album
      const af = await this.client.addAlbumFile(dst.album, src as File)
      return { kind: "albumfile", albumFile: af }
    } else if (dst.kind === "root") {
      if ("album_id" in src) {
        const f = await this.client.copyAlbumFile(src as AlbumFile)
        return { kind: "file", file: f }
      }
      throw new Error("copy: unsupported (file → root)")
    }
    throw new Error("copy: unsupported destination")
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    if (!content || content.length === 0) {
      throw new Error("file size cannot be zero")
    }
    const phys = this.cleanPhysical(physicalPath)
    const name = basename(phys)
    // 目标目录
    const parentPhys = phys.substring(0, phys.lastIndexOf("/")) || "/"
    const dstObj = parentPhys === "/" ? this.root : this.cache.get(parentPhys)
    if (!dstObj) throw new Error("put: destination not found")

    const { contentMd5, sliceMd5, blockListStr } = computeSliceInfo(
      content,
      DEFAULT_SLICE,
      SLICE_MD5_SIZE,
    )

    // 加密 md5（与百度上传校验一致）
    const encContentMd5 = encryptMd5(contentMd5)

    const params: Record<string, string> = {
      autoinit: "1",
      isdir: "0",
      rtype: "1",
      ctype: "11",
      path: `/${name}`,
      size: String(content.length),
      "slice-md5": sliceMd5,
      "content-md5": encContentMd5,
      block_list: blockListStr,
    }

    let precreateResp = await this.client.precreate(
      params,
      this.client.bdstoken,
    )
    let finalFile: File

    if (precreateResp.return_type === 1) {
      // 上传切片
      const blockList = precreateResp.block_list
      const count = blockList.length
      const thread = this.client.thread
      const chunks: Buffer[] = []
      let offset = 0
      for (let i = 0; i < count; i++) {
        const byteSize =
          i === count - 1 ? content.length - offset : DEFAULT_SLICE
        chunks.push(content.subarray(offset, offset + byteSize))
        offset += byteSize
      }
      await runPool(thread, chunks, async (chunk) => {
        const idx = chunks.indexOf(chunk)
        await this.client.uploadSlice(
          precreateResp.uploadid,
          blockList[idx],
          params.path,
          chunk,
        )
      })
      // create
      params.uploadid = precreateResp.uploadid
      const createResp = await this.client.create(params, this.client.bdstoken)
      finalFile = uploadFileToFile(createResp.data)
    } else {
      // return_type 2/3：已存在或已保存
      finalFile = uploadFileToFile(precreateResp.data)
    }

    // 若目标是相册，加入相册
    if (dstObj.kind === "album" && dstObj.album) {
      const af = await this.client.addAlbumFile(dstObj.album, finalFile)
      this.cache.set(phys, { kind: "albumfile", albumFile: af })
    } else {
      this.cache.set(phys, { kind: "file", file: finalFile })
    }
  }
}

/** 简单并发池 */
async function runPool<T>(
  concurrency: number,
  items: T[],
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0
  const runners = new Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(() =>
      (async () => {
        while (idx < items.length) {
          const cur = idx++
          await worker(items[cur])
        }
      })(),
    )
  await Promise.all(runners)
}
