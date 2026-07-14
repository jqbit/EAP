# EAP-Lean — oficio de código mínimo (siempre activo)

> Traducción comunitaria. La referencia es el [README en inglés](README.md).

Disciplina de “senior flojo”: el agente responde una tarea de código con el
**menor código correcto y seguro**, después de entender el problema. Sube una
**escalera de decisión** (YAGNI → reutilizar → stdlib → nativo → dep instalada →
una línea → mínimo) y se detiene en el primer peldaño que sirve.

Concepto derivado de **ponytail** (MIT, Dietrich Gebert). El texto de la regla,
ejemplos y el harness de bench son adaptaciones/ports MIT; el runtime de hooks
de EAP es reimplementación propia. Véase
[`../../docs/legal/ATTRIBUTION.md`](../../docs/legal/ATTRIBUTION.md).

## Niveles

| Nivel | Qué cambia |
|-------|------------|
| **lite** | Construye lo pedido; nombra la alternativa más perezosa en una línea. |
| **full** | Por defecto. Escadera obligatoria. Diff más corto. |
| **ultra** | Extremista YAGNI. Una línea + cuestiona el resto. |
| **off** | Modo normal. |

Cambio: `/eap lean lite|full|ultra|off`. Default de sesión nueva:
`EAP_LEAN_DEFAULT_MODE` o `~/.config/eap/config.json`
(`{"leanDefaultMode":"full"}` / `defaultMode`). Windows:
`%APPDATA%\eap\config.json`. Persistencia explícita:
`/eap lean default <modo>`.

## Skills

`eap-lean` (modo) · `eap-lean-review` · `eap-lean-audit` · `eap-lean-debt` ·
`eap-lean-gain` · `eap-lean-help`

## Docs

- Regla: [`EAP-LEAN.md`](EAP-LEAN.md)
- Nativos de plataforma: [`docs/platform-native.md`](docs/platform-native.md)
- Portabilidad de agentes: [`docs/agent-portability.md`](docs/agent-portability.md)
- Bench (sin % inventados): [`bench/`](bench/)

## Subagentes

`EAP_SUBAGENT_MATCHER` / `EAP_LEAN_SUBAGENT_MATCHER` — regex sobre `agent_type`
(case-insensitive). Sin variable → inyectar en todos.
