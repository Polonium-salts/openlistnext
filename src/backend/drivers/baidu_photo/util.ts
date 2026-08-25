// BaiduPhoto (一刻相册) API client
// Re-ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/baidu_photo
// (utils.go + help.go)
import crypto from "crypto"
import type {
  Album,
  AlbumFile,
  AlbumFileListResp,
  AlbumListResp,
  BaiduPhotoAddition,
  CopyFile,
  CopyFileResp,
  DownloadUrlResp,
  ErronResp,
  File,
  FileListResp,
  InviteResp,
  JoinOrCreateAlbumResp,
  PrecreateResp,
  UInfo,
  UploadFile,
  CreateFileResp,
} from "./types"

const API_URL = "https://photo.baidu.com/youai"
const USER_API_URL = API_URL + "/user/v1"
const ALBUM_API_URL = API_URL + "/album/v1"
const FILE_API_URL_V1 = API_URL + "/file/v1"
const FILE_API_URL_V2 = API_URL + "/file/v2"

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/** 错误码处理（对齐 Go Request） */
function checkErrno(body: unknown): void {
  if (typeof body !== "object" || body === null) return
  const rawErrno = (body as ErronResp)?.errno
  // 百度接口 errno 可能是 number 也可能是 string，统一处理
  const errno = typeof rawErrno === "string" ? parseInt(rawErrno, 10) : rawErrno
  if (typeof errno !== "number" || Number.isNaN(errno)) return
  switch (errno) {
    case 0:
      return
    case 50805:
      throw new Error("you have joined album")
    case 50820:
      throw new Error("no shared albums found")
    case 50100:
      throw new Error("illegal title, only supports 50 characters")
    default: {
      // errno: 2 通常是 Cookie 无效/未登录/缺少 STOKEN
      // 注意：safeErrorMessage 在 >200 字符时返回 "Internal server error"，
      // 所以这里保持简短（只取 msg/errmsg 字段，不整段 JSON）。
      const b = body as any
      const short =
        b?.msg || b?.errmsg || b?.error_msg || b?.message || "unknown"
      throw new Error(
        `baidu_photo errno ${errno}: ${String(short).slice(0, 80)}`,
      )
    }
  }
}

export class BaiduPhotoClient {
  private cookie: string
  private deleteOrigin: boolean
  private uploadThread: number
  /** uk（youa_id） */
  uk = 0
  bdstoken = ""

  constructor(addition: BaiduPhotoAddition) {
    this.cookie = addition.cookie || ""
    this.deleteOrigin = !!addition.delete_origin
    let thread = parseInt(addition.upload_thread || "3", 10)
    if (thread < 1 || isNaN(thread)) thread = 1
    if (thread > 32) thread = 32
    this.uploadThread = thread
  }

  get thread(): number {
    return this.uploadThread
  }

  private async request<T>(
    url: string,
    method: "GET" | "POST" | "HEAD",
    opts: {
      query?: Record<string, string>
      form?: Record<string, string>
      result?: T
      redirect?: "manual" | "follow"
      headers?: Record<string, string>
    } = {},
  ): Promise<{ body: any; status: number; headers: Headers }> {
    const headers: Record<string, string> = {
      Cookie: this.cookie,
      "User-Agent": USER_AGENT,
      ...(opts.headers || {}),
    }
    let fullUrl = url
    if (opts.query && Object.keys(opts.query).length) {
      const qs = new URLSearchParams(opts.query).toString()
      fullUrl += (url.includes("?") ? "&" : "?") + qs
    }

    const init: RequestInit = { method, headers }
    if (method === "POST" && opts.form) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(opts.form)) params.append(k, v)
      init.body = params.toString()
      ;(headers as any)["Content-Type"] = "application/x-www-form-urlencoded"
    }

    const res = await fetch(fullUrl, {
      ...init,
      redirect: opts.redirect || "follow",
    })
    const contentType = res.headers.get("content-type") || ""
    const text = await res.text()
    let body: any = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (typeof body !== "object" || body === null) {
      // 非 JSON 响应：通常是 Cookie 无效时百度返回 HTML 登录/风控页
      console.error(
        `[baidu_photo] non-JSON response (status=${res.status}, content-type=${contentType}): ${String(text).slice(0, 600)}`,
      )
      throw new Error(
        `baidu_photo: API returned non-JSON (status ${res.status}). Cookie may be invalid/expired.`,
      )
    }
    checkErrno(body)
    if (opts.result && body) Object.assign(opts.result as any, body)
    return { body, status: res.status, headers: res.headers }
  }

  private get<T>(
    url: string,
    query?: Record<string, string>,
    result?: T,
  ): Promise<T> {
    return this.request<T>(url, "GET", { query, result }).then(
      (r) => r.body as T,
    )
  }

  private post<T>(
    url: string,
    form?: Record<string, string>,
    query?: Record<string, string>,
    result?: T,
  ): Promise<T> {
    return this.request<T>(url, "POST", { query, form, result }).then(
      (r) => r.body as T,
    )
  }

  // 获取所有根文件
  async getAllFile(): Promise<File[]> {
    const files: File[] = []
    let cursor = ""
    for (;;) {
      const resp = await this.get<any>(FILE_API_URL_V1 + "/list", {
        need_thumbnail: "1",
        need_filter_hidden: "0",
        cursor,
      })
      const list = resp.list
      if (!Array.isArray(list)) {
        const keys = Object.keys(resp).join(",")
        console.error(
          `[baidu_photo] getAllFile unexpected response keys=[${keys}]:`,
          JSON.stringify(resp).slice(0, 800),
        )
        throw new Error(
          `baidu_photo file list API: no 'list' (keys: ${keys.slice(0, 80)})`,
        )
      }
      files.push(...(list as File[]))
      if (!resp.has_more) break
      cursor = resp.cursor
    }
    return files
  }

  // 删除根文件
  async deleteFile(file: File): Promise<void> {
    await this.get(FILE_API_URL_V1 + "/delete", {
      fsid_list: `[${file.fsid}]`,
    })
  }

  // 获取所有相册
  async getAllAlbum(): Promise<Album[]> {
    const albums: Album[] = []
    let cursor = ""
    for (;;) {
      const resp = await this.get<any>(ALBUM_API_URL + "/list", {
        need_amount: "1",
        limit: "100",
        cursor,
      })
      const list = resp.list
      if (!Array.isArray(list)) {
        const keys = Object.keys(resp).join(",")
        console.error(
          `[baidu_photo] getAllAlbum unexpected response keys=[${keys}]:`,
          JSON.stringify(resp).slice(0, 800),
        )
        throw new Error(
          `baidu_photo album list API: no 'list' (keys: ${keys.slice(0, 80)})`,
        )
      }
      albums.push(...(list as Album[]))
      if (!resp.has_more) break
      cursor = resp.cursor
    }
    return albums
  }

  // 获取相册中所有文件
  async getAllAlbumFile(album: Album, passwd = ""): Promise<AlbumFile[]> {
    const files: AlbumFile[] = []
    let cursor = ""
    for (;;) {
      const resp = await this.get<any>(ALBUM_API_URL + "/listfile", {
        album_id: album.album_id,
        need_amount: "1",
        limit: "1000",
        passwd,
        cursor,
      })
      const list = resp.list
      if (!Array.isArray(list)) {
        const keys = Object.keys(resp).join(",")
        console.error(
          `[baidu_photo] getAllAlbumFile unexpected response keys=[${keys}]:`,
          JSON.stringify(resp).slice(0, 800),
        )
        throw new Error(
          `baidu_photo albumfile list API: no 'list' (keys: ${keys.slice(0, 80)})`,
        )
      }
      files.push(...(list as AlbumFile[]))
      if (!resp.has_more) break
      cursor = resp.cursor
    }
    return files
  }

  // 创建相册
  async createAlbum(name: string): Promise<Album> {
    const resp = await this.post<JoinOrCreateAlbumResp>(
      ALBUM_API_URL + "/create",
      {
        title: name,
        tid: getTid(),
        source: "0",
      },
    )
    return this.getAlbumDetail(resp.album_id)
  }

  // 相册改名
  async setAlbumName(album: Album, name: string): Promise<Album> {
    await this.post(ALBUM_API_URL + "/settitle", {
      title: name,
      album_id: album.album_id,
      tid: String(album.tid),
    })
    return renameAlbum(album, name)
  }

  // 删除相册
  async deleteAlbum(album: Album): Promise<void> {
    await this.post(ALBUM_API_URL + "/delete", {
      album_id: album.album_id,
      tid: String(album.tid),
      delete_origin_image: boolToIntStr(this.deleteOrigin),
    })
  }

  // 删除相册文件
  async deleteAlbumFile(file: AlbumFile): Promise<void> {
    await this.post(ALBUM_API_URL + "/delfile", {
      album_id: String(file.album_id),
      tid: String(file.tid),
      list: `[{"fsid":${file.fsid},"uk":${file.uk}}]`,
      del_origin: boolToIntStr(this.deleteOrigin),
    })
  }

  // 增加相册文件（根文件 → 相册）
  async addAlbumFile(album: Album, file: File): Promise<AlbumFile> {
    await this.get(ALBUM_API_URL + "/addfile", {
      album_id: String(album.album_id),
      tid: String(album.tid),
      list: fsidsFormatNotUk(file.fsid),
    })
    return moveFileToAlbumFile(file, album, this.uk)
  }

  // 保存相册文件为根文件
  async copyAlbumFile(file: AlbumFile): Promise<File> {
    const resp = await this.post<CopyFileResp>(ALBUM_API_URL + "/copyfile", {
      album_id: file.album_id,
      tid: String(file.tid),
      uk: String(file.uk),
      list: fsidsFormatNotUk(file.fsid),
    })
    return copyFile(file, resp.list[0])
  }

  // 加入相册
  async joinAlbum(code: string): Promise<Album> {
    const resp = await this.get<InviteResp>(ALBUM_API_URL + "/querypcode", {
      pcode: code,
      web: "1",
    })
    const resp2 = await this.get<JoinOrCreateAlbumResp>(
      ALBUM_API_URL + "/join",
      {
        invite_code: resp.pdata.invite_code,
      },
    )
    return this.getAlbumDetail(resp2.album_id)
  }

  // 获取相册详细信息
  async getAlbumDetail(albumID: string): Promise<Album> {
    const resp = await this.get<Album>(ALBUM_API_URL + "/detail", {
      album_id: albumID,
    })
    return resp
  }

  // 相册文件下载（共享相册，HEAD 取重定向）
  private async linkAlbum(
    file: AlbumFile,
    ip: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT }
    if (ip && !isLocalIP(ip)) headers["X-Forwarded-For"] = ip
    const res = await this.request(ALBUM_API_URL + "/download", "HEAD", {
      query: {
        fsid: String(file.fsid),
        album_id: file.album_id,
        tid: String(file.tid),
        uk: String(file.uk),
      },
      headers,
      redirect: "manual",
    })
    if (res.status !== 302) {
      throw new Error("not found 302 redirect")
    }
    const location = res.headers.get("Location") || ""
    return {
      url: location,
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://photo.baidu.com/",
      },
    }
  }

  // 根文件 / 相册文件（转为根文件后）下载
  private async linkFile(
    file: File,
    ip: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT }
    if (ip && !isLocalIP(ip)) headers["X-Forwarded-For"] = ip
    const resp = await this.request<DownloadUrlResp>(
      FILE_API_URL_V2 + "/download",
      "GET",
      {
        query: { fsid: String(file.fsid) },
        headers,
      },
    )
    const r = resp.body as any
    const dlink = r?.dlink || r?.body?.dlink || ""
    return {
      url: dlink,
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://photo.baidu.com/",
      },
    }
  }

  /**
   * 获取下载链接。相册文件若属于他人共享相册（uk 不同）需要先 CopyAlbumFile 转成根文件。
   * 为简化实现，调用方在 Link 流程里已处理共享相册的 copy，这里对 AlbumFile 直接尝试
   * linkAlbum（HEAD 重定向）失败时回退为 copy 后 linkFile。
   */
  async getLink(
    file: File | AlbumFile,
    ip: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    if ("album_id" in file) {
      const af = file as AlbumFile
      if (this.uk !== af.uk) {
        // 共享相册：先转成根文件再取链接
        const rootFile = await this.copyAlbumFile(af)
        return this.linkFile(rootFile, ip)
      }
      // 自己的相册文件，用内嵌 File 部分
      const baseFile: File = {
        fsid: af.fsid,
        path: af.path,
        size: af.size,
        ctime: af.ctime,
        mtime: af.mtime,
        thumburl: af.thumburl,
        md5: af.md5,
      }
      return this.linkFile(baseFile, ip)
    }
    return this.linkFile(file as File, ip)
  }

  // 获取 uk（youa_id）
  async uInfo(): Promise<UInfo> {
    return this.get<UInfo>(USER_API_URL + "/getuinfo")
  }

  // 获取 bdstoken
  async getBDStoken(): Promise<string> {
    const info = await this.get<{
      result: { bdstoken: string; token: string; uk: number }
    }>(
      "https://pan.baidu.com/api/gettemplatevariable?fields=[%22bdstoken%22,%22token%22,%22uk%22]",
    )
    return info.result?.bdstoken || ""
  }

  // --- 上传（Put） ---
  async precreate(
    params: Record<string, string>,
    bdstoken: string,
  ): Promise<PrecreateResp> {
    return this.post<PrecreateResp>(FILE_API_URL_V1 + "/precreate", params, {
      bdstoken,
    })
  }

  async uploadSlice(
    uploadid: string,
    partseq: number,
    path: string,
    body: Buffer,
  ): Promise<void> {
    const qs = new URLSearchParams({
      method: "upload",
      path,
      partseq: String(partseq),
      uploadid,
      app_id: "16051585",
    }).toString()
    const url = `https://c3.pcs.baidu.com/rest/2.0/pcs/superfile2?${qs}`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Cookie: this.cookie,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(body),
    })
    await res.text()
  }

  async create(
    params: Record<string, string>,
    bdstoken: string,
  ): Promise<CreateFileResp> {
    return this.post<CreateFileResp>(FILE_API_URL_V1 + "/create", params, {
      bdstoken,
    })
  }
}

// --- MD5 混淆（Go DecryptMd5 / EncryptMd5） ---
export function decryptMd5(encryptMd5: string): string {
  if (/^[0-9a-fA-F]{32}$/.test(encryptMd5)) return encryptMd5
  let out = ""
  let n = 0
  for (let i = 0; i < encryptMd5.length; i++) {
    if (i === 9) {
      n = encryptMd5[i].toLowerCase().charCodeAt(0) - "g".charCodeAt(0)
    } else {
      n = parseInt(encryptMd5[i], 16)
    }
    out += (n ^ (15 & i)).toString(16)
  }
  return (
    out.slice(8, 16) + out.slice(0, 8) + out.slice(24, 32) + out.slice(16, 24)
  )
}

export function encryptMd5(originalMd5: string): string {
  const reversed =
    originalMd5.slice(8, 16) +
    originalMd5.slice(0, 8) +
    originalMd5.slice(24, 32) +
    originalMd5.slice(16, 24)
  let out = ""
  for (let i = 0; i < reversed.length; i++) {
    let n = parseInt(reversed[i], 16)
    n ^= 15 & i
    if (i === 9) {
      out += String.fromCharCode(n + "g".charCodeAt(0))
    } else {
      out += n.toString(16)
    }
  }
  return out
}

// --- 工具函数（Go help.go） ---
export function getTid(): string {
  const ts = Math.floor(Date.now() / 1000)
  const rand = Math.floor(Math.random() * 9000000 + 1000000)
  return `3${ts}${rand}`
}

export function getFileName(path: string): string {
  const idx = path.lastIndexOf("/")
  return path.slice(idx + 1)
}

function fsidsFormatNotUk(...ids: number[]): string {
  const buf = ids.map((id) => `{"fsid":${id}}`)
  return `[${buf.join(",")}]`
}

function copyFile(file: AlbumFile, cf: CopyFile): File {
  return {
    fsid: cf.fsid,
    path: cf.path,
    size: file.size,
    ctime: cf.ctime,
    mtime: cf.ctime,
    thumburl: file.thumburl,
    md5: file.md5,
  }
}

function moveFileToAlbumFile(file: File, album: Album, uk: number): AlbumFile {
  return {
    ...file,
    album_id: album.album_id,
    tid: album.tid,
    uk,
  }
}

function renameAlbum(album: Album, newName: string): Album {
  return {
    ...album,
    title: newName,
    mtime: Math.floor(Date.now() / 1000),
  }
}

function boolToIntStr(b: boolean): string {
  return b ? "1" : "0"
}

/** 计算文件整体 MD5 与分片信息（对齐 Go Put 流程） */
export interface SliceInfo {
  count: number
  contentMd5: string
  sliceMd5: string
  blockListStr: string
  sliceMD5List: string[]
}

export function computeSliceInfo(
  buffer: Buffer,
  defaultSize = 1 << 22,
  sliceSize = 1 << 18,
): SliceInfo {
  const streamSize = buffer.length
  let count = 1
  if (streamSize > defaultSize) {
    count = Math.ceil(streamSize / defaultSize)
  }
  let lastBlockSize = streamSize % defaultSize
  if (lastBlockSize === 0) lastBlockSize = defaultSize

  const fileMd5 = crypto.createHash("md5")
  const sliceMd5H2 = crypto.createHash("md5")
  const sliceMD5List: string[] = []

  let offset = 0
  for (let i = 1; i <= count; i++) {
    let byteSize = defaultSize
    if (i === count) byteSize = lastBlockSize
    const chunk = buffer.subarray(offset, offset + byteSize)
    fileMd5.update(chunk)
    // sliceMd5H2 仅取前 sliceSize 字节
    const h2part = chunk.subarray(0, Math.min(sliceSize, chunk.length))
    sliceMd5H2.update(h2part)
    // 每个分片的 md5
    const sliceHash = crypto.createHash("md5").update(chunk).digest("hex")
    sliceMD5List.push(sliceHash)
    offset += byteSize
  }

  const contentMd5 = fileMd5.digest("hex")
  const sliceMd5 = sliceMd5H2.digest("hex")
  const blockListStr = JSON.stringify(sliceMD5List)
  return { count, contentMd5, sliceMd5, blockListStr, sliceMD5List }
}

/** 根据 IP 判断是否为本地地址（从 Go utils.IsLocalIPAddr 简化） */
export function isLocalIP(ip: string): boolean {
  if (!ip) return false
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10)
    if (second >= 16 && second <= 31) return true
  }
  if (ip.startsWith("169.254.")) return true
  return false
}

/** 把 UploadFile 转为 File（用于上传后返回根文件） */
export function uploadFileToFile(uf: UploadFile): File {
  return {
    fsid: uf.fs_id,
    path: uf.path,
    size: uf.size,
    ctime: uf.ctime,
    mtime: uf.mtime,
    thumburl: [],
    md5: uf.md5,
  }
}
