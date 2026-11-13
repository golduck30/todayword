from pathlib import Path
import json
root=Path(__file__).resolve().parents[1]
for n in (5,6,7,8):
 words=(root/'dict'/f'{n}.txt').read_text().split()
 (root/'dict'/f'{n}.js').write_text('registerDictionary('+str(n)+','+json.dumps(words,ensure_ascii=False,separators=(',',':'))+');\n',encoding='utf-8')
 print(n,len(words))
