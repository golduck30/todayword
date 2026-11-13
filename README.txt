오늘의 단어 | 최종 배포용 사전 확장 (2026-11-13)

[업로드]
ZIP에 있는 index.html, game.js, dictionary.js, dict/ 폴더를 GitHub Pages 저장소 루트에 모두 업로드하세요.
기존 파일을 먼저 백업하고, 특히 dict/8.js를 누락하지 마세요.
배포 후 Ctrl+Shift+R로 새로고침하세요.

[포함]
기존 DELUXE 게임, 5~8자모 대결, 상점·랜덤상자·날개·닉네임·강퇴 기능 유지.
기존 단어사전 + 추가 수작업 게임용 단어 402개.
최종 8자모 표제어 472개 (기존 대비 +402개).
5자모: 22722개
6자모: 43077개
7자모: 31737개
8자모: 472개
사전 길이별 지연 로딩과 HTTP 캐시는 유지.

[정확도 및 출처]
외부 공식 사전 전체를 다운로드·통합한 파일이 아닙니다.
기존 words/base_words.txt는 사용자가 이전부터 쓰던 목록,
words/added_words.txt는 이전 보강 목록,
words/curated_8jamo.txt는 일반 생활 어휘를 수작업 선정한 추가 목록입니다.
개별 항목의 국립국어원 표준국어대사전 등재 여부를 일괄 확인하지 못했으며,
일부 복합어·기술 용어 또는 외래어가 표준국어대사전의 단일 표제어가 아닐 수 있습니다.
이러한 기준을 엄격하게 운영하려면 검증된 표제어 원본을 추가하고 재생성하세요.

[재생성]
python3 tools/build_dictionary.py words/base_words.txt words/added_words.txt words/curated_8jamo.txt --out dict
python3 tools/pack_js.py
python3 tools/test_dictionary.py
이때 dictionary.js 내 DICTIONARY_VERSION을 변경해야 캐시가 갱신됩니다.

[검증]
Python 분해 규칙: 초성/중성/종성의 쌍자음·복합 모음·겹받침을 실제 키 입력 자모로 분해.
모든 8자모 항목 길이 검사, 중복 제거, 5~8 분류 검증 및 생성 JS/TXT 일치 검사 완료.
JavaScript 구문 검사 완료. 실제 Firebase 다중 사용자 브라우저 통합 테스트는 미실시.

[참고]
국립국어원 표준국어대사전 https://stdict.korean.go.kr/
국립국어원 우리말샘 https://opendict.korean.go.kr/
공개 한국어 단어 목록 참고: https://github.com/han-dle/pd-korean-noun-list-for-wordles (CC0-1.0)
※ 위 공개 목록을 다운로드해 통째로 복제한 것은 아닙니다.
