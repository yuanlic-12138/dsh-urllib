/* dsh-urllib 本地服务 —— 零依赖，只为让网址库脱离 DSH 独立运行。
 *
 * 职责就三件：
 *   1. 发 index.html / app.js
 *   2. GET /api/file 读、POST /api/write 写（只允许 library.json 和它的 .bak）
 *   3. 最后一次请求后 IDLE_MS 无人理就自己退出，不留常驻进程
 *
 * 端口 3090（127.0.0.1），避开 DSH 的 3080。
 */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_FILE = join(HERE, 'library.json')
const BAK_FILE = DATA_FILE + '.bak'
/* 端口默认 3090，可用 URLLIB_PORT 覆盖（万一别的机器上 3090 被占用） */
const PORT = Number(process.env.URLLIB_PORT) > 0 ? Number(process.env.URLLIB_PORT) : 3090
const HOST = '127.0.0.1'
/* 自灭阈值：最后一次请求后这么久没人理就退出。可用 URLLIB_IDLE_MS 覆盖（便于测试）。 */
const IDLE_MS = Number(process.env.URLLIB_IDLE_MS) > 0 ? Number(process.env.URLLIB_IDLE_MS) : 180000
/* 日志写在本目录里，不绑死任何机器的绝对路径 */
const LOG_FILE = join(HERE, 'server.log')

const PAGES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js'
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

function log(msg) {
  try { appendFileSync(LOG_FILE, new Date().toISOString() + '  ' + msg + '\n') } catch { /* 日志失败不影响服务 */ }
}
function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
/* 安全边界：客户端只能碰这两个文件，不接受任意路径 */
function allowed(p) {
  const t = resolve(String(p || '')).toLowerCase()
  return t === DATA_FILE.toLowerCase() || t === BAK_FILE.toLowerCase()
}
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

let lastSeen = Date.now()

const server = createServer(async (req, res) => {
  lastSeen = Date.now()
  let url
  try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch { sendJson(res, 400, { error: 'bad url' }); return }
  const p = url.pathname

  try {
    if (p === '/api/config') {
      sendJson(res, 200, {
        mode: 'local',
        dataPath: DATA_FILE,
        backupPath: BAK_FILE,
        fileApi: '/api/file?path=',
        writeApi: '/api/write'
      })
      return
    }

    if (p === '/api/ping') {
      sendJson(res, 200, { ok: true })
      return
    }

    if (p === '/api/file') {
      const target = url.searchParams.get('path') || ''
      if (!allowed(target)) { sendJson(res, 403, { error: 'path not allowed' }); return }
      try {
        const text = await readFile(resolve(target), 'utf8')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(text)
      } catch (e) {
        sendJson(res, 404, { error: String(e && e.code ? e.code : e) })
      }
      return
    }

    if (p === '/api/write') {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const body = await readBody(req)
      const target = typeof body.path === 'string' ? body.path : ''
      const content = typeof body.content === 'string' ? body.content : ''
      if (!allowed(target)) { sendJson(res, 403, { error: 'path not allowed' }); return }
      if (content.length > 20 * 1024 * 1024) { sendJson(res, 413, { error: 'content too large' }); return }
      await mkdir(dirname(DATA_FILE), { recursive: true })
      await writeFile(resolve(target), content, 'utf8')
      sendJson(res, 200, { ok: true })
      return
    }

    const page = PAGES[p]
    if (page) {
      const file = join(HERE, page)
      const ext = page.slice(page.lastIndexOf('.'))
      const data = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(data)
      return
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (e) {
    sendJson(res, 500, { error: String(e) })
  }
})

const idleTimer = setInterval(() => {
  if (Date.now() - lastSeen <= IDLE_MS) return
  clearInterval(idleTimer)
  log('idle ' + Math.round(IDLE_MS / 1000) + 's with no request -> exiting')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}, 5000)

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log('port ' + PORT + ' already in use -> exiting quietly')
    process.exit(0)
  }
  log('server error: ' + String(e))
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  log('listening on http://' + HOST + ':' + PORT + '  data=' + DATA_FILE)
})
