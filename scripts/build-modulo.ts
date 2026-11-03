// Genera modulo/agent.md y modulo/skill/registro-proveedor/SKILL.md a partir de las MISMAS fuentes que usa la app
// (agent/prompt.md y src/knowledge/registro-proveedor.md). Se ejecuta en cada `bun run dev`/`start`,
// así el módulo nunca diverge de la aplicación.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const raiz = resolve(import.meta.dir, "..")
const prompt = readFileSync(join(raiz, "agent", "prompt.md"), "utf8")
const conocimiento = readFileSync(join(raiz, "src", "knowledge", "registro-proveedor.md"), "utf8")
const aviso = "<!-- ARCHIVO GENERADO por scripts/build-modulo.ts. No editar aquí: editar la fuente indicada. -->"

const agent = `---
description: Prepara formularios de registro de Periferia como proveedor ante clientes (Excel, PDF o valores para portal) y arma el paquete para firma, sin enviar nada sin confirmación humana.
mode: primary
permission:
  edit: deny
  bash: deny
---
${aviso}
<!-- Fuente: agent/prompt.md -->

${prompt}`

const skill = `---
name: registro-proveedor
description: Conocimiento del proceso de registro de Periferia como proveedor (identificador tributario por país, soportes y vigencias, reglas de datos bancarios y portales). Usar al procesar solicitudes de registro de proveedor.
---
${aviso}
<!-- Fuente: src/knowledge/registro-proveedor.md (reglas automáticas en src/knowledge/reglas.json) -->

${conocimiento}`

mkdirSync(join(raiz, "modulo", "skill", "registro-proveedor"), { recursive: true })
writeFileSync(join(raiz, "modulo", "agent.md"), agent)
writeFileSync(join(raiz, "modulo", "skill", "registro-proveedor", "SKILL.md"), skill)
console.log("modulo/ sincronizado con agent/prompt.md y src/knowledge/registro-proveedor.md")
