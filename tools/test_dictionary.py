from build_dictionary import to_jamo
from pathlib import Path
root=Path(__file__).resolve().parents[1]
all_words={}
for n in (5,6,7,8):
 words=(root/'dict'/f'{n}.txt').read_text().split()
 assert len(words)==len(set(words)), f'duplicates in {n}'
 assert all(len(to_jamo(w))==n for w in words),f'bad jamo count in {n}'
 all_words[n]=set(words)
for w in ['손가락','선풍기','눈사람','손수건','나침반','초콜릿','우체국','휴대폰','전화기']:
 assert w in all_words[8],w
print('PASS', {n:len(w) for n,w in all_words.items()}, '8-jamo sample validations')

# Every generated JS dictionary must match its corresponding TXT data.
import json,re
for n in (5,6,7,8):
    txt=(root/'dict'/f'{n}.txt').read_text(encoding='utf-8').split()
    js=(root/'dict'/f'{n}.js').read_text(encoding='utf-8')
    match=re.fullmatch(r'registerDictionary\('+str(n)+r',(.+)\);\s*',js,re.S)
    assert match, f'Bad dictionary JavaScript format: {n}'
    assert json.loads(match.group(1)) == txt, f'TXT/JS mismatch: {n}'
print('PASS: TXT/JS match across 5-8')
