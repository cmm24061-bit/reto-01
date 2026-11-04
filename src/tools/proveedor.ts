// Herramientas del agente. Cada export es una herramienta; el modelo la ve como `proveedor_<export>`.
// Contrato: execute(args, ctx) devuelve un string JSON { ok, data } | { ok: false, error } y NUNCA lanza.
import { z } from "zod"
import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type CampoPlantilla,
  type CeldaPlantilla,
  type Formato,
  type Resultado,
  type SoporteIndex,
  type Solicitud,
  type ToolContext,
  asegurarDir,
  enmascarar,
  fallo,
  fechaEjecucion,
  leerJson,
  listarCasos,
  ok,
  registrarCaso,
  responder,
  rutas,
  validarCaso,
} from "./_lib.ts"
import { type Mapeo, cargarFuentes, cargarMapeoGuardado, guardarMapeo, mapear, reconciliarMapeo } from "./_mapeo.ts"
import { generarPdf, generarValoresPortal, generarXlsx, nombreFormulario, rutaFormulario } from "./_formularios.ts"

// ───────────────────────── Lógica interna (no son herramientas) ─────────────────────────

interface SolicitudLeida {
  caso: string
  pais: string
  cliente: string
  correo_cliente: string
  asunto: string
  fecha_solicitud: string
  formato: Formato
  campos: string[]
  campos_obligatorios: string[]
  soportes: string[]
  advertencias: string[]
}

interface Plantilla {
  tipo: "celdas" | "campos"
  celdas: CeldaPlantilla[]
  campos: CampoPlantilla[]
}

function cargarSolicitud(directory: string, caso: string): Resultado<Solicitud> {
  const dir = validarCaso(directory, caso)
  if (!dir.ok) return dir
  return leerJson<Solicitud>(join(dir.data, "solicitud.json"), "la solicitud (solicitud.json)")
}

function cargarPlantilla(directory: string, caso: string, formato: string): Resultado<Plantilla> {
  const dir = rutas.caso(directory, caso)
  if (formato === "xlsx") {
    const r = leerJson<CeldaPlantilla[]>(join(dir, "plantilla-celdas.json"), "la plantilla Excel (plantilla-celdas.json)")
    if (!r.ok) return r
    if (!Array.isArray(r.data) || r.data.some((c) => !c.hoja || !c.etiqueta || !c.celda_valor || !c.celda_etiqueta))
      return fallo("La plantilla Excel está corrupta: cada fila debe tener hoja, celda_etiqueta, etiqueta y celda_valor.")
    return ok({ tipo: "celdas", celdas: r.data, campos: r.data.map((c) => ({ etiqueta: c.etiqueta, obligatorio: true })) })
  }
  const r = leerJson<CampoPlantilla[]>(join(dir, "plantilla-campos.json"), "la plantilla de campos (plantilla-campos.json)")
  if (!r.ok) return r
  if (!Array.isArray(r.data) || r.data.some((c) => typeof c.etiqueta !== "string"))
    return fallo("La plantilla de campos está corrupta: cada fila debe tener una etiqueta.")
  return ok({ tipo: "campos", celdas: [], campos: r.data })
}

function leerSolicitudInterna(directory: string, caso: string): Resultado<SolicitudLeida> {
  const s = cargarSolicitud(directory, caso)
  if (!s.ok) return s
  const advertencias: string[] = []
  const formato = s.data.formato
  if (formato !== "xlsx" && formato !== "pdf" && formato !== "portal")
    return fallo(`Formato no soportado: "${formato}". Los formatos válidos son xlsx, pdf y portal.`)
  if (formato === "portal") advertencias.push("Formato portal web: no se llena automáticamente; se generarán los valores para copiar.")

  const p = cargarPlantilla(directory, caso, formato)
  if (!p.ok) return p
  const soportes = leerJson<string[]>(join(rutas.caso(directory, caso), "soportes-exigidos.json"), "la lista de soportes exigidos")
  if (!soportes.ok) advertencias.push(soportes.error + " Se continúa sin soportes exigidos.")

  return ok({
    caso,
    pais: s.data.pais,
    cliente: s.data.cliente,
    correo_cliente: s.data.de,
    asunto: s.data.asunto,
    fecha_solicitud: s.data.fecha,
    formato,
    campos: p.data.campos.map((c) => c.etiqueta),
    campos_obligatorios: p.data.campos.filter((c) => c.obligatorio).map((c) => c.etiqueta),
    soportes: soportes.ok ? soportes.data : [],
    advertencias,
  })
}

function mapearInterno(directory: string, caso: string, campos: string[]): Resultado<Mapeo> {
  const s = cargarSolicitud(directory, caso)
  if (!s.ok) return s
  const f = cargarFuentes(directory)
  if (!f.ok) return f
  const m = mapear(caso, s.data.pais, campos, f.data)
  guardarMapeo(directory, m)
  return ok(m)
}

interface FormularioGenerado {
  ruta: string
  formato: Formato
  soportado: boolean
  mensaje: string
  campos_escritos: number
  campos_vacios: number
}

async function generarInterno(directory: string, caso: string, mapeo: Mapeo): Promise<Resultado<FormularioGenerado>> {
  const sol = cargarSolicitud(directory, caso)
  if (!sol.ok) return sol
  const formato = sol.data.formato as Formato
  const p = cargarPlantilla(directory, caso, formato)
  if (!p.ok) return p
  const f = cargarFuentes(directory)
  if (!f.ok) return f

  const dir = rutas.outCaso(directory, caso)
  asegurarDir(dir)
  const ruta = rutaFormulario(dir, formato)
  const escritos = mapeo.llenos.length + mapeo.requiere_confirmacion.length
  const base = { ruta: `out/${caso}/${nombreFormulario(formato)}`, formato, campos_escritos: escritos, campos_vacios: mapeo.faltantes.length }

  if (formato === "xlsx") {
    await generarXlsx(ruta, p.data.celdas, mapeo, f.data.maestro)
    return ok({ ...base, soportado: true, mensaje: "Excel generado en las hojas y celdas de la plantilla." })
  }
  if (formato === "pdf") {
    await generarPdf(ruta, p.data.campos, mapeo, sol.data)
    return ok({ ...base, soportado: true, mensaje: "PDF generado con todos los campos en el orden de la plantilla." })
  }
  generarValoresPortal(ruta, p.data.campos, mapeo, sol.data)
  return ok({
    ...base,
    soportado: false,
    mensaje: "Formato no soportado: portal web. Se generó valores-portal.md con los valores listos para copiar; una persona debe ingresar al portal.",
  })
}

interface ItemChecklist {
  tipo: string
  nombre: string
  estado: "presente" | "vencido" | "ausente"
  vigencia_hasta: string | null
  archivo: string | null
}

interface PaqueteArmado {
  ruta: string
  listo_para_firma: boolean
  motivos_bloqueo: string[]
  fecha_ejecucion: string
  formulario: string
  checklist: {
    soportes: ItemChecklist[]
    campos_faltantes: string[]
    campos_por_confirmar: { etiqueta: string; nota: string }[]
  }
  archivos: string[]
}

function evaluarSoportes(directory: string, exigidos: string[], fecha: string, nombres: Record<string, string>): Resultado<ItemChecklist[]> {
  const idx = leerJson<SoporteIndex[]>(join(rutas.soportesDir(directory), "index.json"), "el índice de soportes")
  if (!idx.ok) return idx
  return ok(
    exigidos.map((tipo): ItemChecklist => {
      const nombre = nombres[tipo] ?? tipo
      const s = idx.data.find((x) => x.tipo === tipo)
      if (!s || !existsSync(join(rutas.soportesDir(directory), s.archivo)))
        return { tipo, nombre, estado: "ausente", vigencia_hasta: null, archivo: null }
      const vencido = s.vigencia_hasta !== null && s.vigencia_hasta < fecha
      return { tipo, nombre, estado: vencido ? "vencido" : "presente", vigencia_hasta: s.vigencia_hasta, archivo: s.archivo }
    }),
  )
}

function escribirChecklist(ruta: string, sol: SolicitudLeida, p: Omit<PaqueteArmado, "archivos" | "ruta">): void {
  const icono = { presente: "✅ presente", vencido: "⚠️ VENCIDO", ausente: "❌ AUSENTE" }
  const lineas = [
    `# Checklist — ${sol.cliente} (${sol.caso})`,
    "",
    `- Fecha de ejecución: ${p.fecha_ejecucion}`,
    `- Formato: ${sol.formato}`,
    `- **Listo para firma: ${p.listo_para_firma ? "SÍ" : "NO"}**`,
    ...p.motivos_bloqueo.map((m) => `  - ${m}`),
    "",
    "## Soportes exigidos",
    "",
    "| Soporte | Estado | Vigencia hasta | Archivo |",
    "|---|---|---|---|",
    ...p.checklist.soportes.map((s) => `| ${s.nombre} | ${icono[s.estado]} | ${s.vigencia_hasta ?? "no aplica"} | ${s.archivo ?? "—"} |`),
    "",
    "## Campos faltantes (no bloquean la firma)",
    "",
    ...(p.checklist.campos_faltantes.length ? p.checklist.campos_faltantes.map((c) => `- [ ] ${c}`) : ["- Ninguno"]),
    "",
    "## Campos que requieren confirmación",
    "",
    ...(p.checklist.campos_por_confirmar.length
      ? p.checklist.campos_por_confirmar.map((c) => `- [ ] ${c.etiqueta}: ${c.nota}`)
      : ["- Ninguno"]),
    "",
    "## Antes de enviar",
    "",
    "- [ ] Revisar el formulario",
    "- [ ] Firma del representante legal",
    "- [ ] Envío al cliente (decisión humana)",
  ]
  writeFileSync(ruta, lineas.join("\n"))
}

function escribirBorrador(ruta: string, sol: SolicitudLeida, p: Omit<PaqueteArmado, "archivos" | "ruta">, adjuntos: string[]): void {
  // RN2: el borrador NUNCA incluye datos bancarios.
  const pendientes = [
    ...p.checklist.soportes.filter((s) => s.estado !== "presente").map((s) => `${s.nombre} (${s.estado})`),
    ...p.checklist.campos_faltantes.map((c) => `Campo "${c}"`),
  ]
  const lineas = [
    `**Para:** ${sol.correo_cliente}`,
    `**Asunto:** RE: ${sol.asunto}`,
    "",
    "Buen día,",
    "",
    `En respuesta a su solicitud, adjuntamos el formulario de registro de Periferia IT Group como proveedor de ${sol.cliente}, firmado por nuestro representante legal, junto con los siguientes soportes:`,
    "",
    ...adjuntos.map((a) => `- ${a}`),
    "",
    ...(pendientes.length
      ? ["Quedan pendientes y los enviaremos a la mayor brevedad:", "", ...pendientes.map((x) => `- ${x}`), ""]
      : []),
    "Quedamos atentos a cualquier inquietud.",
    "",
    "Cordialmente,",
    "Área Administrativa — Periferia IT Group",
    "",
    "---",
    "_Borrador generado por el agente. No ha sido enviado. Revisar antes de usar._",
  ]
  writeFileSync(ruta, lineas.join("\n"))
}

// ───────────────────────────────────── Herramientas ─────────────────────────────────────

export const listar_casos = {
  description: "Lista los casos (solicitudes de registro) disponibles en la carpeta de entrada, con cliente, país y formato.",
  args: {},
  async execute(_args: Record<string, never>, ctx: ToolContext): Promise<string> {
    try {
      const casos = listarCasos(ctx.directory).map((caso) => {
        const s = cargarSolicitud(ctx.directory, caso)
        return s.ok ? { caso, cliente: s.data.cliente, pais: s.data.pais, formato: s.data.formato } : { caso, error: s.error }
      })
      return responder(ok({ casos }))
    } catch {
      return responder(fallo("No se pudo listar los casos."))
    }
  },
}

export const leer_solicitud = {
  description: "Lee el correo y la plantilla de un caso y devuelve país, cliente, formato de salida, campos solicitados y soportes exigidos.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, por ejemplo 'ec-corp-andina'"),
  },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const r = leerSolicitudInterna(ctx.directory, args.caso)
      if (validarCaso(ctx.directory, args.caso).ok)
        registrarCaso(ctx.directory, args.caso, "proveedor_leer_solicitud", r.ok, r.ok ? `${r.data.campos.length} campos, formato ${r.data.formato}` : r.error)
      return responder(r)
    } catch {
      return responder(fallo("Error inesperado al leer la solicitud."))
    }
  },
}

export const mapear_campos = {
  description: "Cruza las etiquetas de campos pedidas por el cliente con el repositorio maestro y clasifica cada una en llenos, faltantes o requiere_confirmacion.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    campos: z.array(z.string()).min(1).describe("Etiquetas de los campos tal como las devolvió proveedor_leer_solicitud"),
  },
  async execute(args: { caso: string; campos: string[] }, ctx: ToolContext): Promise<string> {
    try {
      const r = mapearInterno(ctx.directory, args.caso, args.campos)
      if (!r.ok) return responder(r)
      // RN2: los valores bancarios se devuelven enmascarados al modelo; el archivo usa el valor real del maestro.
      const enmascararSiBanco = (clave: string, v: string) => (clave.startsWith("banco.") && clave !== "banco.nombre" && clave !== "banco.tipo_cuenta" ? enmascarar(v) : v)
      const data = {
        caso: r.data.caso,
        pais: r.data.pais,
        llenos: r.data.llenos.map((c) => ({ ...c, valor: enmascararSiBanco(c.clave, c.valor) })),
        faltantes: r.data.faltantes,
        requiere_confirmacion: r.data.requiere_confirmacion.map((c) => ({ ...c, valor_propuesto: enmascararSiBanco(c.clave, c.valor_propuesto) })),
        resumen: `${r.data.llenos.length} llenos, ${r.data.faltantes.length} faltantes, ${r.data.requiere_confirmacion.length} por confirmar`,
      }
      registrarCaso(ctx.directory, args.caso, "proveedor_mapear_campos", true, data.resumen)
      return responder(ok(data))
    } catch {
      return responder(fallo("Error inesperado al mapear los campos."))
    }
  },
}

const itemMapeo = z.object({
  etiqueta: z.string().describe("Etiqueta del campo"),
  clave: z.string().describe("Clave del maestro asignada"),
})

export const generar_formulario = {
  description: "Genera el formulario lleno en el formato del cliente (xlsx o pdf; para portal genera valores para copiar) usando el mapeo; los valores siempre se toman del maestro.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    mapeo: z
      .object({
        llenos: z.array(itemMapeo).describe("Campos llenos del mapeo"),
        requiere_confirmacion: z.array(itemMapeo).describe("Campos que requieren confirmación"),
        faltantes: z.array(z.object({ etiqueta: z.string() })).describe("Campos faltantes"),
      })
      .optional()
      .describe("Resultado de proveedor_mapear_campos. Si se omite, se usa el último mapeo guardado del caso."),
  },
  async execute(
    args: { caso: string; mapeo?: { llenos: { etiqueta: string; clave: string }[]; requiere_confirmacion: { etiqueta: string; clave: string }[]; faltantes: { etiqueta: string }[] } },
    ctx: ToolContext,
  ): Promise<string> {
    try {
      const caso = validarCaso(ctx.directory, args.caso)
      if (!caso.ok) return responder(caso)
      const guardado = cargarMapeoGuardado(ctx.directory, args.caso)
      let mapeo: Mapeo
      if (guardado.ok) {
        const f = cargarFuentes(ctx.directory)
        if (!f.ok) return responder(f)
        mapeo = args.mapeo ? reconciliarMapeo(guardado.data, args.mapeo, f.data) : guardado.data
      } else {
        const sol = leerSolicitudInterna(ctx.directory, args.caso)
        if (!sol.ok) return responder(sol)
        const m = mapearInterno(ctx.directory, args.caso, sol.data.campos)
        if (!m.ok) return responder(m)
        mapeo = m.data
      }
      const r = await generarInterno(ctx.directory, args.caso, mapeo)
      registrarCaso(ctx.directory, args.caso, "proveedor_generar_formulario", r.ok, r.ok ? r.data.mensaje : r.error)
      return responder(r)
    } catch {
      return responder(fallo("Error inesperado al generar el formulario."))
    }
  },
}

export const armar_paquete = {
  description: "Arma out/<caso>/paquete/ con formulario, soportes vigentes, checklist y borrador de correo, e indica si está listo para firma.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
  },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const sol = leerSolicitudInterna(ctx.directory, args.caso)
      if (!sol.ok) return responder(sol)
      const f = cargarFuentes(ctx.directory)
      if (!f.ok) return responder(f)
      const dirCaso = rutas.outCaso(ctx.directory, args.caso)

      // Si aún no hay mapeo o formulario, se generan (el paquete no depende del orden de llamadas).
      let mapeo = cargarMapeoGuardado(ctx.directory, args.caso)
      if (!mapeo.ok) mapeo = mapearInterno(ctx.directory, args.caso, sol.data.campos)
      if (!mapeo.ok) return responder(mapeo)
      const rutaForm = rutaFormulario(dirCaso, sol.data.formato)
      if (!existsSync(rutaForm)) {
        const g = await generarInterno(ctx.directory, args.caso, mapeo.data)
        if (!g.ok) return responder(g)
      }

      const fecha = fechaEjecucion()
      const soportes = evaluarSoportes(ctx.directory, sol.data.soportes, fecha, f.data.reglas.nombres_soportes)
      if (!soportes.ok) return responder(soportes)

      const dirPaquete = join(dirCaso, "paquete")
      rmSync(dirPaquete, { recursive: true, force: true })
      asegurarDir(dirPaquete)
      const nombreForm = nombreFormulario(sol.data.formato)
      copyFileSync(rutaForm, join(dirPaquete, nombreForm))
      const archivos = [nombreForm]
      const adjuntos = [`Formulario de registro (${nombreForm})`]
      for (const s of soportes.data) {
        if (s.archivo && s.estado === "presente") {
          copyFileSync(join(rutas.soportesDir(ctx.directory), s.archivo), join(dirPaquete, s.archivo))
          archivos.push(s.archivo)
          adjuntos.push(s.nombre)
        }
      }

      const motivos = [
        ...soportes.data.filter((s) => s.estado === "vencido").map((s) => `Soporte vencido: ${s.nombre} (venció ${s.vigencia_hasta})`),
        ...soportes.data.filter((s) => s.estado === "ausente").map((s) => `Soporte ausente: ${s.nombre}`),
      ]
      const base = {
        listo_para_firma: motivos.length === 0,
        motivos_bloqueo: motivos,
        fecha_ejecucion: fecha,
        formulario: `out/${args.caso}/paquete/${nombreForm}`,
        checklist: {
          soportes: soportes.data,
          campos_faltantes: mapeo.data.faltantes.map((c) => c.etiqueta),
          campos_por_confirmar: mapeo.data.requiere_confirmacion.map((c) => ({ etiqueta: c.etiqueta, nota: c.nota })),
        },
      }
      escribirChecklist(join(dirPaquete, "checklist.md"), sol.data, base)
      escribirBorrador(join(dirPaquete, "borrador-correo.md"), sol.data, base, adjuntos)
      archivos.push("checklist.md", "borrador-correo.md")

      const data: PaqueteArmado = { ruta: `out/${args.caso}/paquete/`, ...base, archivos }
      writeFileSync(join(dirCaso, "estado-paquete.json"), JSON.stringify(data, null, 2))
      registrarCaso(ctx.directory, args.caso, "proveedor_armar_paquete", true, `listo_para_firma=${data.listo_para_firma}; ${motivos.join("; ") || "sin bloqueos"}`)
      return responder(ok(data))
    } catch {
      return responder(fallo("Error inesperado al armar el paquete."))
    }
  },
}

export const simular_envio = {
  description: "Simula el envío del paquete al cliente escribiendo out/<caso>/ENVIO-SIMULADO.md; solo funciona con confirmación explícita del usuario.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    confirmado: z.boolean().describe("true solo si el usuario confirmó explícitamente el envío en su último mensaje"),
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: ToolContext): Promise<string> {
    try {
      const caso = validarCaso(ctx.directory, args.caso)
      if (!caso.ok) return responder(caso)
      // RN4: el servidor decide si hubo confirmación humana real; el modelo no puede saltársela.
      if (!args.confirmado || ctx.confirmacionHumana === false) {
        registrarCaso(ctx.directory, args.caso, "proveedor_simular_envio", false, "rechazado: sin confirmación explícita")
        return responder(fallo("requiere confirmación explícita"))
      }
      const estado = leerJson<{ listo_para_firma: boolean; motivos_bloqueo: string[]; archivos: string[] }>(
        join(rutas.outCaso(ctx.directory, args.caso), "estado-paquete.json"),
        "el paquete",
      )
      if (!estado.ok) return responder(fallo("Primero hay que armar el paquete con proveedor_armar_paquete."))
      const sol = cargarSolicitud(ctx.directory, args.caso)
      if (!sol.ok) return responder(sol)

      const ruta = `out/${args.caso}/ENVIO-SIMULADO.md`
      const advertencia = estado.data.listo_para_firma ? null : "El paquete NO estaba listo para firma al momento del envío simulado."
      const contenido = [
        "# ENVÍO SIMULADO",
        "",
        "> Este archivo reemplaza el envío real. No se envió ningún correo.",
        "",
        `- Fecha: ${new Date().toISOString()}`,
        `- Para: ${sol.data.de}`,
        `- Asunto: RE: ${sol.data.asunto}`,
        `- Confirmado por el usuario en la sesión: ${ctx.sessionId}`,
        `- Listo para firma: ${estado.data.listo_para_firma ? "sí" : "no"}`,
        ...(advertencia ? ["", `**Advertencia:** ${advertencia}`, ...estado.data.motivos_bloqueo.map((m) => `- ${m}`)] : []),
        "",
        "## Adjuntos",
        "",
        ...estado.data.archivos.map((a) => `- paquete/${a}`),
      ].join("\n")
      writeFileSync(join(rutas.outCaso(ctx.directory, args.caso), "ENVIO-SIMULADO.md"), contenido)
      registrarCaso(ctx.directory, args.caso, "proveedor_simular_envio", true, "envío simulado escrito")
      return responder(ok({ ruta, listo_para_firma: estado.data.listo_para_firma, advertencia }))
    } catch {
      return responder(fallo("Error inesperado al simular el envío."))
    }
  },
}
