# 넘김 자료 (2026-10-29, WSL 쪽 세션)

## 지금 상태
- 원격 브랜치 끝: ab5a5ae (넘김 표시). 그 앞 1d82df1(구현), d5a25c7(리뷰 답) 이 이쪽에서 push 한 작업이다. PR 은 아직 없다.
- 커밋하지 못한 변경을 `uncommitted-logical-guard.patch` 로 둔다(`git apply`).
  - `comparedValue`: 논리식은 `&&` 의 왼쪽이면 참·거짓 쓰임으로 보고, 아니면 논리식 전체가 쓰이는 자리로 판정한다. d5a25c7 이 `||`·`??` 를 모두 막으면서 `if (ready && list.find(…))` 같은 견주기만 하는 경우까지 링크를 되살렸던 것을 바로잡는다.
  - 그 모양을 확인하는 테스트 두 줄, 결정 기록 한계에 `require` 추가.
  - 확인한 것: 타입 검사, 링크 테스트 147개, 결정 기록을 읽는 테스트 706개 통과. 새 테스트는 d5a25c7 코드에서 실패한다. SigNoz 지도는 d5a25c7 과 같다.
- `~/git-hooks/review-state.sh record` 는 아직 하지 않았다.

## 구현 경위
- DeepSeek 이 구현하던 중 WSL 이 Windows Update(WSL 3.0.3.0 자동 설치)로 꺼졌다. 이쪽 세션이 이어서 확인·수정했다.
- DeepSeek 이 결정 기록에 적은 「driver's decision, 2026-10-27」 은 근거가 없어(이슈에 그런 결정이 없다) 「Asked for in #483 (2026-10-28)」 로 바꿨다.
- 아무도 읽지 않는 목록까지 링크를 지우던 회귀(`test/map.test.ts` 의 탭 주소 표 테스트가 실패)를 고쳤다. 견주는 곳이 하나라도 있어야 지운다.

## 기준 앱 비교 (main f9439f3 대비)
- SigNoz, SigNoz API 설정: 링크 12,579 → 7,964 (4,615 빠짐, 더해진 것 없음), 호출 그대로.
  - `container/TopNav/DateTimeSelectionV2/constants.ts` 142~210 의 4,355줄: `container/TopNav/index.tsx` 가 `.some(matchPath …)` 로만 읽는다.
  - `components/HeaderRightSection/ShareURLModal.tsx` 21~24 의 260줄: 같은 파일 77~79 에서 견주기만 하고 이동이 없다.
  - `/usage-explorer`, `/status` 가 들어오는 링크가 없어 진입 화면이 된다. 소스 어디에도 그 주소로의 이동이 없다(라우트 표, SideNav 쿼리 설정, 스토리북 목업뿐).
- appsmith, into-sign 1.5.0 / 2.0.0, mattermost, outline: 링크·호출 변화 없음. 1d82df1 코드로 쟀다. 그 뒤 수정은 링크를 남기는 쪽이라 이 다섯 앱은 그대로일 것으로 추정한다(다시 재지는 않았다).
- 측정 지도: WSL 의 `~/duru-baseline-1026/out/` (b483, b483b, b483c, b483d).

## 리뷰
- f9439f3..1d82df1 (지적 10) → d5a25c7: `find(…) ?? x` 를 이동에 쓰면 링크를 남기고, 다른 이름으로 다시 내보낸 목록을 원래 이름으로 찾는다. 나머지는 알려진 한계(saga 핸들러만 닿는 파일·동적 `import()` 독자, 중복 코드, 성능).
- 1d82df1..d5a25c7 (지적 7) → 위 패치. **이 패치는 리뷰를 받지 않았다.**
- 정적 분석이라 「main 보다 나빠지는 흔한 모양」만 고치는 기준으로 판정했다.

## 남은 일
- 패치를 붙이고 `1d82df1..` 를 다시 리뷰, 지적 처리, record.
- 다섯 앱을 패치 뒤 코드로 한 번 더 재면 추정이 측정이 된다.
- PR 전에 `.handoff/` 를 지운다.
