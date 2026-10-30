# hit0607 컴퓨터에서 넘기는 자료 (2026-10-30)

## 브랜치 상태
- 이 컴퓨터가 올린 마지막 커밋은 6ccef0e(확인할 입력란의 fine 표시)다. STOP.md 를 읽은 뒤로 이 브랜치에 코드 커밋을 더하지 않았다.
- `comment-sweep.patch`: 이 브랜치가 src 에 더한 주석 92줄 가운데 82줄을 지우고 10줄을 남긴 정리다. 코드 줄은 바꾸지 않았다. 6ccef0e 위에 `git am` 으로 붙는다. 타입 검사 두 개와 `test/screen-inputs.test.ts`·`test/api-calls.test.ts`·`test/marks.test.ts` 133개가 통과했다.
- `comment-gate-result.txt`: 이 넘김 커밋을 올리려 할 때 push 앞 주석 검사(`comment-diet-range.sh origin/main`)가 낸 판정이다. 이 판정은 패치를 붙이기 전의 브랜치를 읽은 것이다. 테스트 파일(`test/api-calls.test.ts`, `test/screen-inputs.test.ts`)의 주석도 지우거나 줄이라고 하는데, 패치는 테스트 파일을 건드리지 않는다. 패치가 남긴 줄 가운데서도 두 줄을 더 줄이라고 했다. api-calls-worker.ts 의 표식 모양 줄은 「n 은 경로 번호다」만 남기고, cli.ts 의 fine 줄은 지우라는 것이다.

## 리뷰
- `/code-review` 는 아직 돌리지 않았고, `review-state.sh record` 도 하지 않았다.

## 실제 앱으로 잰 결과 (into-sign 1.6.0, release/1.6.0 829bc0c482)
설정은 `~/duru-verify-out/is-1.6.0-qa.config.json` 에 `requestFunction: {import: "./_ajax/Ajax", name: "axios", method: "0.info.METHOD", url: "0.info.URL", body: "0.data"}` 를 더한 것이다.
- 호출은 198개다. requestFunction 없이 만든 지도와 호출 목록이 같고, API 함수 217개도 inputs 를 빼면 같다.
- API 함수 175개가 inputs 를, 18개가 inputsUnknown 을 얻었다. 나머지 24개는 브라우저를 옮겨 받는 다운로드라 실행되지 않는다.
- ajaxWorkspaceDocumentBffUpdateSigner 가 보내는 키는 `0.data` 아래 signer.name·email·cellPhone 과 signer.attribute.enabledAuth·authType·authPassword·authPasswordHint·notificationTypes·notificationContexts 다. pkiSignType 은 보내지 않는다.
- rebuild 출력은 `input keys to check 128` 과 `input keys unknown 58` 이다. 모름 58개 가운데 23개는 `ModalCreateDraftDocument/ModalCreate/index.js:149` 한 곳에서 키가 문자열이 아니어서 생긴다.
- 서명자 정보 수정 창이 열리는 화면 세 곳(`/detail/document/:id#DetailDocument`, `/detail/document-batch/:id#DetailBatchDocument`, `/detail/document-link/:id#DetailLinkDocument`)에서 확인할 입력란은 각 화면에 4개씩이다. PKI 키 3개는 `SignerPkiSign/index.js:130`, `:164`, `:185` 에 적혀 있고, 남은 하나는 `SignerInfo/index.js:249` 의 `signer.memberId` 다. 그 함수의 키 목록(AjaxFunc.js:4686, 4693-4698)에 memberId 는 없다.

## 이 컴퓨터에서 막힌 것
- DeepSeek: 09:59 실행이 `dsh: AUTH: 401 Invalid API key` 로 끝났다. 그 뒤로는 DeepSeek 에 일을 넘기지 못했다.
- 리뷰 페이지 「입력란」 작업은 이 컴퓨터에서 시작하지 못했다. 처음에는 작업자가 `deepseek-run` 을 `qex run` 으로 감싸 띄워, 코어 4개짜리 요청 둘이 6코어 한도에 들지 못하고 서로를 기다렸다. 다시 띄울 때는 자동 권한 검사가 실행을 거절했고, 그다음이 위의 401 이다.
- deepseek-worker 정의에 「deepseek-run 을 qex 로 감싸지 않는다」는 줄이 없다. 08:33 무렵의 `duru-js` 작업도 같은 모양이었던 것으로 추정한다.

## 이 이슈에 남긴 결정
- #487 댓글 6508328164 에 화면 쪽 판정을 「모델 판단·미확인」으로 적었다.
- 리뷰 페이지에 「입력란」을 「화면 정보」의 「접근 조건」 바로 아래에 두는 안은 모델 판단·미확인이다.
