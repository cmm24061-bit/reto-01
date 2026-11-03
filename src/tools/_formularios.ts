// Generación del formulario en el formato pedido por el cliente.
import { join } from "node:path"
import { writeFileSync } from "node:fs"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import type { CampoPlantilla, CeldaPlantilla, JsonObjeto, Solicitud } from "./_lib.ts"
import { valorPorRuta } from "./_lib.ts"
import type { Mapeo } from "./_mapeo.ts"

export interface ValorCampo {
  etiqueta: string
  valor: string
  estado: "lleno" | "requiere_confirmacion" | "faltante"
  nota?: string
}

/** Une el mapeo en un diccionario etiqueta → valor/estado. */
export function valoresPorEtiqueta(m: Mapeo): Map<string, ValorCampo> {
  const mapa = new Map<string, ValorCampo>()
  for (const c of m.llenos) mapa.set(c.etiqueta, { etiqueta: c.etiqueta, valor: c.valor, estado: "lleno" })
  for (const c of m.requiere_confirmacion)
    mapa.set(c.etiqueta, { etiqueta: c.etiqueta, valor: c.valor_propuesto, estado: "requiere_confirmacion", nota: c.nota })
  for (const c of m.faltantes) mapa.set(c.etiqueta, { etiqueta: c.etiqueta, valor: "", estado: "faltante", nota: c.motivo })
  return mapa
}

/** P0: escribe cada etiqueta y su valor exactamente en la hoja y celda indicadas. */
export async function generarXlsx(
  ruta: string, plantilla: CeldaPlantilla[], m: Mapeo, maestro: JsonObjeto,
): Promise<void> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "Agente Registro Proveedor"
  const valores = valoresPorEtiqueta(m)
  const clavePorEtiqueta = new Map<string, string>()
  for (const c of m.llenos) clavePorEtiqueta.set(c.etiqueta, c.clave)
  for (const c of m.requiere_confirmacion) clavePorEtiqueta.set(c.etiqueta, c.clave)

  for (const celda of plantilla) {
    const hoja = wb.getWorksheet(celda.hoja) ?? wb.addWorksheet(celda.hoja)
    const etiquetaCell = hoja.getCell(celda.celda_etiqueta)
    etiquetaCell.value = celda.etiqueta
    etiquetaCell.font = { bold: true }

    const v = valores.get(celda.etiqueta)
    const valorCell = hoja.getCell(celda.celda_valor)
    if (!v || v.estado === "faltante") {
      valorCell.value = null
      continue
    }
    // Conserva números como números (ej. número de empleados) tomando el valor original del maestro.
    const clave = clavePorEtiqueta.get(celda.etiqueta)
    const original = clave ? valorPorRuta(maestro, clave) : undefined
    valorCell.value = typeof original === "number" ? original : v.valor
    if (v.estado === "requiere_confirmacion") {
      valorCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } }
      valorCell.note = v.nota ?? "Requiere confirmación"
    }
  }
  for (const hoja of wb.worksheets) {
    for (const col of hoja.columns) col.width = 28
  }
  await wb.xlsx.writeFile(ruta)
}

/** Reemplaza caracteres que la fuente estándar del PDF no puede dibujar. */
function textoSeguro(font: PDFFont, texto: string): string {
  let salida = ""
  for (const ch of texto) {
    try {
      font.encodeText(ch)
      salida += ch
    } catch {
      salida += ch === "→" ? "->" : "?"
    }
  }
  return salida
}

function partirLineas(font: PDFFont, texto: string, tamano: number, ancho: number): string[] {
  const palabras = texto.split(/\s+/)
  const lineas: string[] = []
  let actual = ""
  for (const p of palabras) {
    const prueba = actual ? `${actual} ${p}` : p
    if (font.widthOfTextAtSize(prueba, tamano) > ancho && actual) {
      lineas.push(actual)
      actual = p
    } else actual = prueba
  }
  if (actual) lineas.push(actual)
  return lineas.length ? lineas : [""]
}

/** P1: genera un PDF con todos los campos (etiqueta + valor) en el orden de la plantilla. */
export async function generarPdf(
  ruta: string, plantilla: CampoPlantilla[], m: Mapeo, solicitud: Solicitud,
): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const valores = valoresPorEtiqueta(m)
  const margen = 50
  let page: PDFPage = doc.addPage([595, 842])
  let y = 842 - margen
  const ancho = 595 - margen * 2

  const escribir = (t: string, f: PDFFont, tam: number, color = rgb(0, 0, 0)) => {
    for (const linea of partirLineas(f, textoSeguro(f, t), tam, ancho)) {
      if (y < margen + 20) {
        page = doc.addPage([595, 842])
        y = 842 - margen
      }
      page.drawText(linea, { x: margen, y, size: tam, font: f, color })
      y -= tam + 4
    }
  }

  escribir("Formulario de registro de proveedor", bold, 16)
  escribir(`Cliente: ${solicitud.cliente} (${solicitud.pais})`, font, 11)
  escribir(`Referencia: ${solicitud.asunto}`, font, 10, rgb(0.3, 0.3, 0.3))
  y -= 10

  for (const campo of plantilla) {
    const v = valores.get(campo.etiqueta)
    const marca = campo.obligatorio ? " *" : ""
    escribir(`${campo.etiqueta}${marca}`, bold, 10)
    if (!v || v.estado === "faltante") escribir("________________________________", font, 10, rgb(0.5, 0.5, 0.5))
    else escribir(v.valor, font, 11)
    if (v?.estado === "requiere_confirmacion") escribir(`(Requiere confirmación: ${v.nota ?? ""})`, font, 8, rgb(0.7, 0.4, 0))
    y -= 6
  }

  y -= 20
  escribir("* Campo obligatorio", font, 8, rgb(0.4, 0.4, 0.4))
  y -= 30
  escribir("Firma del representante legal: ________________________________", font, 10)
  writeFileSync(ruta, await doc.save())
}

/** P2: el portal no se automatiza; se dejan los valores listos para copiar. */
export function generarValoresPortal(ruta: string, plantilla: CampoPlantilla[], m: Mapeo, solicitud: Solicitud): void {
  const valores = valoresPorEtiqueta(m)
  const filas = plantilla.map((c) => {
    const v = valores.get(c.etiqueta)
    const valor = !v || v.estado === "faltante" ? "**FALTANTE**" : `\`${v.valor}\``
    const estado = v?.estado ?? "faltante"
    return `| ${c.etiqueta}${c.obligatorio ? " *" : ""} | ${valor} | ${estado}${v?.nota ? ` — ${v.nota}` : ""} |`
  })
  const contenido = [
    `# Valores para el portal — ${solicitud.cliente}`,
    "",
    "> **Formato no soportado para llenado automático.** El agente no ingresa a portales web.",
    "> Una persona debe entrar con sus credenciales, copiar estos valores y hacer clic en \"Enviar\".",
    "",
    "| Campo | Valor | Estado |",
    "|---|---|---|",
    ...filas,
    "",
    "\\* Campo obligatorio.",
  ].join("\n")
  writeFileSync(ruta, contenido)
}

export function nombreFormulario(formato: string): string {
  if (formato === "xlsx") return "formulario.xlsx"
  if (formato === "pdf") return "formulario.pdf"
  return "valores-portal.md"
}

export function rutaFormulario(dirCaso: string, formato: string): string {
  return join(dirCaso, nombreFormulario(formato))
}
