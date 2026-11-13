#!/usr/bin/env python3
"""Build canonical jamo-length dictionaries from newline/whitespace-delimited Korean words.
Usage: python3 tools/build_dictionary.py words/base_words.txt words/added_words.txt [more_words.txt ...]
No network or extra Python dependencies required.
"""
from pathlib import Path
from collections import Counter
import argparse, json, re
CHO='ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
VOW='ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
JONG=['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']
COMB={'ㄲ':'ㄱㄱ','ㄸ':'ㄷㄷ','ㅃ':'ㅂㅂ','ㅆ':'ㅅㅅ','ㅉ':'ㅈㅈ','ㄳ':'ㄱㅅ','ㄵ':'ㄴㅈ','ㄶ':'ㄴㅎ','ㄺ':'ㄹㄱ','ㄻ':'ㄹㅁ','ㄼ':'ㄹㅂ','ㄽ':'ㄹㅅ','ㄾ':'ㄹㅌ','ㄿ':'ㄹㅍ','ㅀ':'ㄹㅎ','ㅄ':'ㅂㅅ','ㅐ':'ㅏㅣ','ㅒ':'ㅑㅣ','ㅔ':'ㅓㅣ','ㅖ':'ㅕㅣ','ㅘ':'ㅗㅏ','ㅙ':'ㅗㅏㅣ','ㅚ':'ㅗㅣ','ㅝ':'ㅜㅓ','ㅞ':'ㅜㅓㅣ','ㅟ':'ㅜㅣ','ㅢ':'ㅡㅣ'}
HANGUL=re.compile(r'^[가-힣]+$')
def to_jamo(word):
    result=[]
    for ch in word:
        n=ord(ch)-0xAC00
        if not (0 <= n < 11172): raise ValueError(f'non Hangul: {word}')
        c,v,t=n//588,(n%588)//28,n%28
        for j in [CHO[c],VOW[v],JONG[t]]:
            if j:result.extend(COMB.get(j,j))
    return ''.join(result)
def build(paths,outdir):
    buckets={n:set() for n in (5,6,7,8)}
    rejected=Counter()
    for file in paths:
        for word in Path(file).read_text(encoding='utf-8-sig').split():
            if not HANGUL.fullmatch(word): rejected['not_korean']+=1; continue
            length=len(to_jamo(word))
            if length in buckets: buckets[length].add(word)
            else: rejected['outside_5_to_8']+=1
    outdir.mkdir(parents=True,exist_ok=True)
    for length,words in buckets.items():
        (outdir/f'{length}.txt').write_text('\n'.join(sorted(words))+'\n',encoding='utf-8')
    manifest={str(n):len(w) for n,w in buckets.items()}
    (outdir/'manifest.json').write_text(json.dumps({'counts':manifest,'excluded':dict(rejected)},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('valid words per jamo length:',manifest,'excluded:',dict(rejected))
    print('8-jamo examples:',', '.join(sorted(buckets[8])[:30]))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('sources',nargs='+');p.add_argument('--out',default='dict');a=p.parse_args()
    build(a.sources,Path(a.out))
