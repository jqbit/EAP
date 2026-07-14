# EAP-Lean — 최소 코드 규율 (항상 켜짐)

> 커뮤니티 번역. 기준본은 [영어 README](README.md).

“게으른 시니어” 규율: 에이전트는 문제를 **먼저 이해한 뒤**, 올바르고 안전한
**최소 코드**로 코딩 작업에 답한다. **결정 사다리**(YAGNI → 재사용 → stdlib →
네이티브 → 설치된 의존성 → 한 줄 → 최소)를 오르며 첫 유효 단에서 멈춘다.

**ponytail**(MIT, Dietrich Gebert)에서 개념을 가져와 재표현. 규칙 본문·예제·벤치
하니스는 MIT 포트/각색; EAP 훅 런타임은 독자 재구현. 출처:
[`../../docs/legal/ATTRIBUTION.md`](../../docs/legal/ATTRIBUTION.md).

## 레벨

| 레벨 | 변화 |
|------|------|
| **lite** | 요청대로 구현하고, 더 게으른 대안을 한 줄로 고지. |
| **full** | 기본. 사다리 강제. 최단 diff. |
| **ultra** | YAGNI 극단. 한 줄 해법 + 나머지 요구에 이의. |
| **off** | 일반 모드. |

전환: `/eap lean lite|full|ultra|off`. 새 세션 기본값:
`EAP_LEAN_DEFAULT_MODE` 또는 `~/.config/eap/config.json`
(`{"leanDefaultMode":"full"}` / `defaultMode`). Windows:
`%APPDATA%\eap\config.json`. 명시 저장: `/eap lean default <mode>`.

## 스킬

`eap-lean`(모드) · `eap-lean-review` · `eap-lean-audit` · `eap-lean-debt` ·
`eap-lean-gain` · `eap-lean-help`

## 문서

- 규칙: [`EAP-LEAN.md`](EAP-LEAN.md)
- 플랫폼 네이티브: [`docs/platform-native.md`](docs/platform-native.md)
- 에이전트 이식성: [`docs/agent-portability.md`](docs/agent-portability.md)
- 벤치(가짜 % 없음): [`bench/`](bench/)

## 서브에이전트

`EAP_SUBAGENT_MATCHER` / `EAP_LEAN_SUBAGENT_MATCHER` — `agent_type` 정규식
(대소문자 무시). 미설정 시 모든 서브에이전트에 주입.
