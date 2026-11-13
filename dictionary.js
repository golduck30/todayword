/* 자모 길이별 사전 지연 로딩: 별도 JS 파일에 등록, 브라우저 HTTP 캐시 활용.
   Python builder: tools/build_dictionary.py / tools/pack_js.py */
const dictSet = new Set();
const loadedDictionaryLengths = new Set();
const loadingDictionaryLengths = new Map();
const DICTIONARY_VERSION = '20261113-3';
function registerDictionary(length, words) {
    if (![5,6,7,8].includes(Number(length)) || !Array.isArray(words)) return;
    for (const word of words) if (/^[가-힣]+$/.test(word)) dictSet.add(word);
    loadedDictionaryLengths.add(Number(length));
}
function isDictionaryReady(length) { return loadedDictionaryLengths.has(Number(length)); }
function ensureDictionaryForLength(length) {
    length = Number(length);
    if (![5,6,7,8].includes(length)) return Promise.reject(new Error('지원하지 않는 자모 수'));
    if (isDictionaryReady(length)) return Promise.resolve(true);
    if (loadingDictionaryLengths.has(length)) return loadingDictionaryLengths.get(length);
    const promise = new Promise((resolve,reject) => {
        const script = document.createElement('script');
        script.src = `dict/${length}.js?v=${DICTIONARY_VERSION}`;
        script.async = true;
        script.onload = () => isDictionaryReady(length) ? resolve(true) : reject(new Error('사전 데이터가 비어 있습니다'));
        script.onerror = () => reject(new Error('사전 파일을 불러오지 못했습니다'));
        document.head.appendChild(script);
    }).finally(() => loadingDictionaryLengths.delete(length));
    loadingDictionaryLengths.set(length,promise);
    return promise;
}
