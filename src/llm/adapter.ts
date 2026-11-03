// Interfaz propia del proveedor de modelo. El ciclo del agente solo conoce estos tipos;
// cambiar de proveedor = escribir otra implementación de `ProveedorLLM`.

export interface LlamadaHerramienta {
  id: string
  nombre: string
  args: unknown
}

export type Mensaje =
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[] }
  | { rol: "resultado_herramienta"; id: string; nombre: string; contenido: string }

export interface DefinicionParaModelo {
  nombre: string
  descripcion: string
  esquema: Record<string, unknown>
}

export interface RespuestaLLM {
  texto: string
  llamadas: LlamadaHerramienta[]
  uso: { entrada: number; salida: number }
}

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionParaModelo[]): Promise<RespuestaLLM>
}

/** Error del proveedor con un mensaje apto para mostrar al usuario (sin claves ni trazas). */
export class ErrorLLM extends Error {
  constructor(public readonly mensajeUsuario: string) {
    super(mensajeUsuario)
  }
}
