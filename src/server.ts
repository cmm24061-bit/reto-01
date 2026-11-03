// API HTTP + front estático. El ciclo del agente vive en agent.ts; las herramientas en tools/.
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { procesarTurno, obtenerSesion, type Config } from "./agent.ts"
import type { ProveedorLLM } from "./llm/adapter.ts"
import { ProveedorAnthropic } from "./llm/anthropic.ts"
import { ProveedorSimulado } from "./llm/simulado.ts"
import { dentroDe, listarCasos } from "./tools/_lib.ts"

const directory = resolve(import.meta.dir, "..")
const entero = (v: string | undefined, def: number) => (v && /^\d+$/.test(v) ? Number(v) : def)

const cfg: Config = {
  directory,
  maxIteraciones: entero(process.env.MAX_ITERACIONES, 25),
  maxTokensSesion: entero(process.env.MAX_TOKENS_SESION, 300_000),
  maxTokensGlobal: entero(process.env.MAX_TOKENS_GLOBAL, 3_000_000),
}

function crearProveedor(): ProveedorLLM {
  const proveedor = process.env.LLM_PROVIDER ?? "anthropic"
  if (proveedor === "simulado") return new ProveedorSimulado(listarCasos(directory))
  const clave = process.env.ANTHROPIC_API_KEY
  if (!clave) {
    console.warn("ANTHROPIC_API_KEY no está definida: se usa el proveedor simulado (sin modelo de lenguaje).")
    return new ProveedorSimulado(listarCasos(directory))
  }
  return new ProveedorAnthropic(clave, process.env.LLM_MODEL ?? "claude-sonnet-5-5", entero(process.env.LLM_TIMEOUT_MS, 90_000))
}

const llm = crearProveedor()
const claveAcceso = process.env.APP_ACCESS_KEY ?? ""
const enCurso = new Set<string>()

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } })

function autorizado(req: Request): boolean {
  if (!claveAcceso) return true
  // Los enlaces de descarga no pueden enviar cabeceras, por eso se acepta también ?key=
  return req.headers.get("x-access-key") === claveAcceso || new URL(req.url).searchParams.get("key") === claveAcceso
}

function listarArchivos(dir: string): string[] {
  if (!existsSync(dir)) return []
  const salida: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) salida.push(...listarArchivos(p))
    else salida.push(relative(directory, p))
  }
  return salida.sort()
}

const tipos: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
}

const puerto = entero(process.env.PORT, 3000)

Bun.serve({
  port: puerto,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname

    if (p === "/" || p === "/index.html") return new Response(Bun.file(join(directory, "web", "index.html")))
    if (p === "/api/health") return json({ ok: true, provider: llm.nombre, model: llm.modelo, accessKeyRequired: Boolean(claveAcceso) })

    if (!p.startsWith("/api/")) return new Response("No encontrado", { status: 404 })
    if (!autorizado(req)) return json({ ok: false, error: "Clave de acceso inválida." }, 401)

    if (p === "/api/chat" && req.method === "POST") {
      let body: { sessionId?: unknown; message?: unknown }
      try {
        body = (await req.json()) as { sessionId?: unknown; message?: unknown }
      } catch {
        return json({ ok: false, error: "Cuerpo inválido." }, 400)
      }
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
      const message = typeof body.message === "string" ? body.message.trim() : ""
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) return json({ ok: false, error: "sessionId inválido." }, 400)
      if (!message || message.length > 4000) return json({ ok: false, error: "El mensaje está vacío o es demasiado largo." }, 400)
      if (enCurso.has(sessionId)) return json({ ok: false, error: "Ya hay un mensaje en proceso en esta sesión." }, 409)
      enCurso.add(sessionId)
      try {
        const sesion = obtenerSesion(directory, sessionId)
        return json(await procesarTurno(llm, cfg, sesion, message))
      } catch {
        return json({ reply: "Ocurrió un error inesperado en el servidor. La sesión sigue activa; intenta de nuevo.", toolCalls: [], needsConfirmation: false })
      } finally {
        enCurso.delete(sessionId)
      }
    }

    const mSesion = p.match(/^\/api\/sessions\/([a-zA-Z0-9-]{8,64})$/)
    if (mSesion && req.method === "GET") {
      const s = obtenerSesion(directory, mSesion[1] ?? "")
      return json({ id: s.id, eventos: s.eventos, esperandoConfirmacion: s.esperandoConfirmacion })
    }

    if (p === "/api/casos") return json({ casos: listarCasos(directory) })

    const mArchivos = p.match(/^\/api\/archivos\/([a-z0-9-]+)$/i)
    if (mArchivos) return json({ archivos: listarArchivos(join(directory, "out", mArchivos[1] ?? "")) })

    if (p === "/api/archivo") {
      const ruta = url.searchParams.get("ruta") ?? ""
      const abs = resolve(directory, ruta)
      if (!dentroDe(join(directory, "out"), abs) || !existsSync(abs) || !statSync(abs).isFile())
        return json({ ok: false, error: "Archivo no disponible." }, 404)
      const ext = abs.slice(abs.lastIndexOf("."))
      return new Response(Bun.file(abs), { headers: { "content-type": tipos[ext] ?? "application/octet-stream" } })
    }

    return json({ ok: false, error: "Ruta no encontrada." }, 404)
  },
})

console.log(`Agente listo en http://localhost:${puerto} · proveedor: ${llm.nombre} · modelo: ${llm.modelo}`)
