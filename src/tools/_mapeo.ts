// Lógica de mapeo de etiquetas del cliente → claves del maestro.
import { join } from "node:path"
import { writeFileSync } from "node:fs"
import {
  type JsonObjeto,
  type Reglas,
  type Resultado,
  asegurarDir,
  fallo,
  leerJson,
  normalizar,
  ok,
  rutas,
  valorATexto,
  valorPorRuta,
} from "./_lib.ts"

export interface CampoLleno {
  etiqueta: string
  clave: string
  valor: string
  ruta: string
  confianza: number
}

export interface CampoConfirmar {
  etiqueta: string
  clave: string
  valor_propuesto: string
  ruta: string
  confianza: number
  nota: string
}

export interface CampoFaltante {
  etiqueta: string
  motivo: string
}

export interface Mapeo {
  caso: string
  pais: string
  llenos: CampoLleno[]
  faltantes: CampoFaltante[]
  requiere_confirmacion: CampoConfirmar[]
}

export interface Fuentes {
  maestro: JsonObjeto
  glosario: Record<string, string>
  reglas: Reglas
}

export function cargarFuentes(directory: string): Resultado<Fuentes> {
  const maestro = leerJson<JsonObjeto>(rutas.maestro(directory), "el repositorio maestro (maestro.json)")
  if (!maestro.ok) return maestro
  const glosario = leerJson<Record<string, string>>(rutas.glosario(directory), "el glosario de campos")
  if (!glosario.ok) return glosario
  const reglas = leerJson<Reglas>(rutas.reglas(directory), "las reglas de negocio (reglas.json)")
  if (!reglas.ok) return reglas
  return ok({ maestro: maestro.data, glosario: glosario.data, reglas: reglas.data })
}

interface Resolucion {
  clave: string
  confianza: number
  via: string
}

function tokens(texto: string, vacias: Set<string>): Set<string> {
  return new Set(normalizar(texto).split(" ").filter((t) => t && !vacias.has(t)))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/** Encuentra la clave del maestro para una etiqueta: exacta → normalizada → aproximada. */
export function resolverEtiqueta(etiqueta: string, f: Fuentes): Resolucion | null {
  const exacta = f.glosario[etiqueta]
  if (exacta) return { clave: exacta, confianza: 1, via: "glosario" }

  const norm = normalizar(etiqueta)
  for (const [sinonimo, clave] of Object.entries(f.glosario)) {
    if (normalizar(sinonimo) === norm) return { clave, confianza: 0.95, via: `glosario ("${sinonimo}")` }
  }

  const vacias = new Set(f.reglas.palabras_vacias)
  const t = tokens(etiqueta, vacias)
  let mejor: Resolucion | null = null
  for (const [sinonimo, clave] of Object.entries(f.glosario)) {
    const s = jaccard(t, tokens(sinonimo, vacias))
    if (!mejor || s > mejor.confianza) mejor = { clave, confianza: Number(s.toFixed(2)), via: `aproximado a "${sinonimo}"` }
  }
  if (mejor && mejor.confianza >= f.reglas.umbral_sugerencia) return mejor
  return null
}

export function mapear(caso: string, pais: string, etiquetas: string[], f: Fuentes): Mapeo {
  const m: Mapeo = { caso, pais, llenos: [], faltantes: [], requiere_confirmacion: [] }
  const r = f.reglas

  for (const etiqueta of etiquetas) {
    const res = resolverEtiqueta(etiqueta, f)
    if (!res) {
      m.faltantes.push({ etiqueta, motivo: "No existe en el glosario ni en el repositorio maestro." })
      continue
    }
    const valor = valorPorRuta(f.maestro, res.clave)
    if (valor === undefined || valor === null || valor === "") {
      m.faltantes.push({ etiqueta, motivo: `La clave "${res.clave}" no tiene valor en el repositorio maestro.` })
      continue
    }
    const texto = valorATexto(valor)
    const ruta = `maestro.json#${res.clave}`

    // RN1: identificador tributario por país.
    if (res.clave === r.clave_identificador_tributario) {
      const idPais = r.identificador_tributario_por_pais[pais] ?? "identificador tributario"
      const ambigua = r.etiquetas_ambiguas.some((a) => normalizar(a) === normalizar(etiqueta))
      if (ambigua) {
        m.requiere_confirmacion.push({
          etiqueta, clave: res.clave, valor_propuesto: texto, ruta, confianza: res.confianza,
          nota: `Etiqueta ambigua: para ${pais} el equivalente es ${idPais}. Se propone el NIT de Periferia.` +
            (pais !== r.pais_del_maestro ? " Identificador extranjero." : ""),
        })
        continue
      }
      if (pais !== r.pais_del_maestro) {
        m.requiere_confirmacion.push({
          etiqueta, clave: res.clave, valor_propuesto: texto, ruta, confianza: res.confianza,
          nota: `Identificador extranjero: el cliente pide ${idPais}; se usó el NIT colombiano.`,
        })
        continue
      }
    }

    if (res.confianza < r.umbral_confianza) {
      m.requiere_confirmacion.push({
        etiqueta, clave: res.clave, valor_propuesto: texto, ruta, confianza: res.confianza,
        nota: `Mapeo con baja confianza (${res.via}).`,
      })
      continue
    }

    m.llenos.push({ etiqueta, clave: res.clave, valor: texto, ruta, confianza: res.confianza })
  }
  return m
}

export function guardarMapeo(directory: string, m: Mapeo): void {
  const dir = rutas.outCaso(directory, m.caso)
  asegurarDir(dir)
  writeFileSync(join(dir, "mapeo.json"), JSON.stringify(m, null, 2))
}

export function cargarMapeoGuardado(directory: string, caso: string): Resultado<Mapeo> {
  const r = leerJson<Mapeo>(join(rutas.outCaso(directory, caso), "mapeo.json"), "el mapeo guardado")
  if (!r.ok) return fallo("No hay un mapeo guardado para este caso. Ejecuta primero proveedor_mapear_campos.")
  return r
}

/**
 * Reconstruye un mapeo a partir de lo que envió el modelo, pero tomando SIEMPRE el valor del maestro
 * por su clave. Así el modelo no puede introducir un valor inventado en el formulario.
 */
export function reconciliarMapeo(
  base: Mapeo,
  enviado: { llenos: { etiqueta: string; clave: string }[]; requiere_confirmacion: { etiqueta: string; clave: string }[] },
  f: Fuentes,
): Mapeo {
  const porEtiqueta = new Map<string, { estado: "lleno" | "confirmar"; clave: string }>()
  for (const c of enviado.llenos) porEtiqueta.set(c.etiqueta, { estado: "lleno", clave: c.clave })
  for (const c of enviado.requiere_confirmacion) porEtiqueta.set(c.etiqueta, { estado: "confirmar", clave: c.clave })

  const resultado: Mapeo = { ...base, llenos: [], faltantes: [], requiere_confirmacion: [] }
  const todos = [
    ...base.llenos.map((c) => c.etiqueta),
    ...base.requiere_confirmacion.map((c) => c.etiqueta),
    ...base.faltantes.map((c) => c.etiqueta),
  ]
  for (const etiqueta of todos) {
    const original =
      base.llenos.find((c) => c.etiqueta === etiqueta) ??
      base.requiere_confirmacion.find((c) => c.etiqueta === etiqueta)
    const pedido = porEtiqueta.get(etiqueta)
    const clave = pedido?.clave ?? original?.clave
    const valor = clave ? valorPorRuta(f.maestro, clave) : undefined
    if (!clave || valor === undefined || valor === null || valor === "") {
      resultado.faltantes.push(base.faltantes.find((c) => c.etiqueta === etiqueta) ?? { etiqueta, motivo: "Sin fuente en el maestro." })
      continue
    }
    const confirmarOriginal = base.requiere_confirmacion.find((c) => c.etiqueta === etiqueta)
    const texto = valorATexto(valor)
    if (confirmarOriginal || pedido?.estado === "confirmar" || clave !== original?.clave) {
      resultado.requiere_confirmacion.push({
        etiqueta, clave, valor_propuesto: texto, ruta: `maestro.json#${clave}`,
        confianza: confirmarOriginal?.confianza ?? 0.5,
        nota: confirmarOriginal?.nota ?? "Clave cambiada respecto al mapeo automático; verificar.",
      })
    } else {
      resultado.llenos.push({ etiqueta, clave, valor: texto, ruta: `maestro.json#${clave}`, confianza: original?.confianza ?? 1 })
    }
  }
  return resultado
}
