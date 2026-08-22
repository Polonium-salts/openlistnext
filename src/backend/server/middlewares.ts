import { Context } from "hono"
import { verify } from "hono/jwt"
import { checkAdminAuth } from "../pkg/utils"
import { getDb } from "../internal/model/db"
import { UserPermissionObj } from "../pkg/permission"

export const JWT_SECRET = "super-secret-openlistnext-key"

export async function adminAuthMiddleware(
  c: Context,
  next: () => Promise<void>,
) {
  const isAdmin = await checkAdminAuth(c)
  if (!isAdmin) {
    return c.json(
      {
        code: 401,
        message: "Unauthorized admin privilege required",
        data: null,
      },
      401,
    )
  }
  await next()
}

/**
 * 从请求中提取 JWT token。
 * 优先级：Authorization 头 > ?token= 查询参数。
 * 查询参数用于浏览器原生下载/预览（<a href>、<video src>、<img src> 等）
 * 无法携带自定义 Authorization 头的场景。
 */
function extractToken(c: Context): string | null {
  const authHeader = c.req.header("Authorization")
  if (authHeader) {
    return authHeader.startsWith("Bearer ")
      ? authHeader.substring(7)
      : authHeader
  }
  const queryToken = c.req.query("token")
  if (queryToken) return queryToken
  return null
}

/**
 * 解析请求中的 JWT，将当前用户信息注入到 c.set("user", ...)。
 * - 未携带 token / token 无效 / 用户被禁用 → user = null
 * - 解析成功 → user 包含 role / permission / disabled / base_path
 * 后续路由通过 c.get("user") 获取，并配合 canWrite / canRemove 等做权限判断。
 */
export async function authMiddleware(
  c: Context,
  next: () => Promise<void>,
) {
  const token = extractToken(c)
  let user: UserPermissionObj | null = null
  if (token) {
    try {
      const payload = await verify(token, JWT_SECRET, "HS256")
      const db = await getDb((c as any).env)
      const dbUser = db.users?.find(
        (u: any) => u.id === payload.id || u.username === payload.username,
      )
      if (dbUser && !dbUser.disabled) {
        user = {
          role: dbUser.role,
          permission: dbUser.permission ?? 0,
          disabled: dbUser.disabled,
          base_path: dbUser.base_path || "/",
        }
      }
    } catch {
      // token 无效或已过期 → user 保持 null，视为未登录
    }
  }
  c.set("user", user)
  await next()
}
