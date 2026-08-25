// BaiduPhoto (一刻相册) types
// Re-ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/baidu_photo
// (types.go + meta.go)

export interface BaiduPhotoAddition {
  cookie: string
  show_type: string // "root" | "root_only_album" | "root_only_file"
  album_id?: string
  delete_origin?: boolean
  upload_thread?: string
}

export interface UInfo {
  youa_id: string // uk
}

export interface Page {
  has_more: number
  cursor: string
}

export interface FileListResp extends Page {
  list: File[]
}

/** 根文件 */
export interface File {
  fsid: number
  path: string
  size: number
  ctime: number
  mtime: number
  thumburl: string[]
  md5: string
}

/** 相册（目录） */
export interface Album {
  album_id: string
  tid: number
  title: string
  join_time: number
  create_time: number
  mtime: number
}

export interface AlbumListResp extends Page {
  list: Album[]
  total_count: number
}

/** 相册内文件 */
export interface AlbumFile {
  // 内嵌 File 字段（扁平 JSON）
  fsid: number
  path: string
  size: number
  ctime: number
  mtime: number
  thumburl: string[]
  md5: string
  // 相册特有字段
  album_id: string
  tid: number
  uk: number
}

export interface AlbumFileListResp extends Page {
  list: AlbumFile[]
  total_count: number
}

export interface CopyFile {
  from_fsid: number
  ctime: number
  fsid: number
  path: string
  shoot_time: number
}

export interface CopyFileResp {
  list: CopyFile[]
}

export interface UploadFile {
  fs_id: number
  size: number
  md5: string
  server_filename: string
  path: string
  ctime: number
  mtime: number
  isdir: number
  category: number
  server_md5: string
  shoot_time: number
}

export interface CreateFileResp {
  data: UploadFile
}

export interface PrecreateResp {
  return_type: number // 1 不存在, 2 已存在, 3 已保存
  data: UploadFile
  path: string
  uploadid: string
  block_list: number[]
}

export interface InviteResp {
  pdata: {
    invite_code: string
    expire_time: number
    share_id: string
  }
}

export interface JoinOrCreateAlbumResp {
  album_id: string
  already_exists: number
}

/** 下载链接响应（FILE_API_URL_V2/download） */
export interface DownloadUrlResp {
  dlink: string
}

/** 通用错误响应 */
export interface ErronResp {
  errno: number
  request_id: number
}
