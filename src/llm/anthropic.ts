// Implementación del adaptador para Anthropic (Messages API) usando fetch, sin SDK.
import { ErrorLLM, type DefinicionParaModelo, type Mensaje, type ProveedorLLM, type RespuestaLLM } from "./adapter.ts"

type BloqueAnthropic =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }

interface MensajeAnthropic {
  role: "user" | "assistant"
  content: BloqueAnthropic[]
}

interface RespuestaAnthropic {
  content: BloqueAnthropic[]
  usage?: { input_tokens: number; output_tokens: number }
}

function convertir(mensajes: Mensaje[]): MensajeAnthropic[] {
  const salida: MensajeAnthropic[] = []
  const agregar = (role: "user" | "assistant", bloque: BloqueAnthropic) => {
    const ultimo = salida[salida.length - 1]
    if (ultimo && ultimo.role === role) ultimo.content.push(bloque)
    else salida.push({ role, content: [bloque] })
  }
  for (const m of mensajes) {
    if (m.rol === "usuario") agregar("user", { type: "text", text: m.texto })
    else if (m.rol === "resultado_herramienta") agregar("user", { type: "tool_result", tool_use_id: m.id, content: m.contenido })
    else {
      if (m.texto) agregar("assistant", { type: "text", text: m.texto })
      for (const l of m.llamadas) agregar("assistant", { type: "tool_use", id: l.id, name: l.nombre, input: l.args ?? {} })
    }
  }
  return salida
}

export class ProveedorAnthropic implements ProveedorLLM {
  readonly nombre = "anthropic"

  constructor(
    private readonly apiKey: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
    private readonly maxTokensRespuesta = 2048,
  ) {}

  async enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionParaModelo[]): Promise<RespuestaLLM> {
    const controlador = new AbortController()
    const temporizador = setTimeout(() => controlador.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controlador.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.modelo,
          max_tokens: this.maxTokensRespuesta,
          system: sistema,
          messages: convertir(mensajes),
          tools: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.esquema })),
        }),
      })
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError")
        throw new ErrorLLM(`El modelo no respondió en ${Math.round(this.timeoutMs / 1000)} segundos. Intenta de nuevo.`)
      throw new ErrorLLM("No se pudo conectar con el proveedor del modelo. Revisa la conexión e intenta de nuevo.")
    } finally {
      clearTimeout(temporizador)
    }

    if (!res.ok) {
      const mensajes: Record<number, string> = {
        401: "La clave del modelo no es válida. Revisa la variable ANTHROPIC_API_KEY en el servidor.",
        403: "La clave del modelo no tiene permiso para este modelo.",
        404: `El modelo "${this.modelo}" no existe o no está disponible. Revisa LLM_MODEL.`,
        429: "Se alcanzó el límite de uso del proveedor. Espera un momento e intenta de nuevo.",
        529: "El proveedor del modelo está saturado. Intenta de nuevo en unos segundos.",
      }
      throw new ErrorLLM(mensajes[res.status] ?? `El proveedor del modelo respondió con un error (${res.status}).`)
    }

    const json = (await res.json()) as RespuestaAnthropic
    const texto = json.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    const llamadas = json.content
      .filter((b): b is { type: "tool_use"; id: string; name: string; input: unknown } => b.type === "tool_use")
      .map((b) => ({ id: b.id, nombre: b.name, args: b.input }))
    return { texto, llamadas, uso: { entrada: json.usage?.input_tokens ?? 0, salida: json.usage?.output_tokens ?? 0 } }
  }
}
