/* 오늘의 단어 - 연출 전용 모듈 (구매/코인 로직과 독립) */
(function(){
'use strict';
const STYLES={
  'fx:confetti':{title:'🎊 축하 파티!',sub:'컬러풀 컨페티',color:'#22c55e',scene:'confetti',duration:2900},
  'fx:stars':{title:'⭐ 별빛의 주인공',sub:'별자리 소환',color:'#fbbf24',scene:'stars',duration:3100},
  'fx:hearts':{title:'💖 사랑이 팡팡!',sub:'하트 풍선이 떠올라요',color:'#fb7185',scene:'hearts',duration:3200},
  'fx:flowers':{title:'🌸 꽃비 내리는 날',sub:'꽃잎이 바람을 타고',color:'#f9a8d4',scene:'flowers',duration:3500},
  'fx:lightning':{title:'⚡ 번개 같은 정답!',sub:'천둥의 일격',color:'#67e8f9',scene:'lightning',duration:2600},
  'fx:diamonds':{title:'💎 찬란한 결정',sub:'보석이 솟아올라요',color:'#7dd3fc',scene:'diamonds',duration:3300},
  'fx:crowns':{title:'👑 정답의 제왕',sub:'황금 왕관 강림',color:'#fbbf24',scene:'crowns',duration:3400},
  'fx:supernova':{title:'🌌 SUPERNOVA!',sub:'은하 폭발 · 우주 진동',color:'#c4b5fd',scene:'supernova',duration:3900},
  'fx:dragon':{title:'🐉 용의 포효!',sub:'불꽃 용이 하늘을 가른다',color:'#fb923c',scene:'dragon',duration:3700},
  'fx:rainbow':{title:'🌈 무지개 피날레',sub:'일곱 빛깔의 커튼',color:'#a78bfa',scene:'rainbow',duration:3500},
  'fx:fireworks':{title:'🎆 불꽃축제!',sub:'하늘을 가득 채운 폭죽',color:'#f472b6',scene:'fireworks',duration:4000}
};
const $= (t,c,parent)=>{const e=document.createElement(t);e.className=c||'';if(parent)parent.appendChild(e);return e};
const set=(el,props)=>{Object.entries(props).forEach(([k,v])=>el.style.setProperty(k,''+v));return el};
const rand=(i,salt=0)=>{let n=Math.sin((i+1)*127.1+salt*311.7)*43758.5453123;return n-Math.floor(n)};
let cleanup=null;
function particle(layer,cls,glyph,x,y,dx,dy,delay,duration,rotate=0){
 const e=$('span','tw-particle '+cls,layer);e.textContent=glyph;
 set(e,{'--x':x+'%','--y':y+'%','--dx':dx+'px','--dy':dy+'px','--r':rotate+'deg','--delay':delay+'ms','--life':duration+'ms'});
 return e;
}
function arcs(layer,x,y,count,color){
 for(let i=0;i<count;i++){
  const a=$('span','tw-firework-bit',layer), theta=Math.PI*2*i/count;
  set(a,{'--x':x+'%','--y':y+'%','--dx':Math.round(Math.cos(theta)* (55+18*(i%3)))+'px','--dy':Math.round(Math.sin(theta)*(55+18*(i%3)))+'px','--delay':(x*10+y*3)%470+'ms','--c':color});
 }
}
function build(layer,s,reduce){
 const sc=$('div','tw-scene tw-scene-'+s.scene,layer);sc.style.setProperty('--accent',s.color);
 // Every purchased effect has its own scene composition, not a recolored generic burst.
 if(s.scene==='confetti'){
  for(let i=0;i<54;i++)particle(sc,'tw-confetti','▰',rand(i,5)*100,-12-rand(i,1)*23,(rand(i,2)-.5)*130,510+rand(i,3)*170,i*24,2200+rand(i,4)*700,i*51);
 }
 if(s.scene==='stars'){
  const orbit=$('div','tw-star-orbit',sc);
  for(let i=0;i<16;i++){let a=$('span','tw-orbit-star',orbit);a.textContent=i%3===0?'✦':'★';set(a,{'--angle':i*22.5+'deg','--d':(100+i%4*25)+'px','--delay':i*50+'ms'});}
  for(let i=0;i<25;i++)particle(sc,'tw-starfall','✧',rand(i,5)*100,rand(i,7)*110,0,0,i*55,1800);
 }
 if(s.scene==='hearts'){
  for(let i=0;i<38;i++){let g=['♥','❤','♡','💖'][i%4];particle(sc,'tw-heart',g,10+rand(i,1)*80,106+rand(i,2)*28,(rand(i,3)-.5)*150,-380-rand(i,4)*280,i*65,2350+rand(i,5)*850,(rand(i,6)-.5)*55);}
 }
 if(s.scene==='flowers'){
  for(let i=0;i<42;i++)particle(sc,'tw-petal',['🌸','❀','✿'][i%3],rand(i,1)*100,-5-rand(i,2)*25, (rand(i,3)-.5)*220,590+rand(i,4)*220,i*75,2600+rand(i,5)*750,i*39);
 }
 if(s.scene==='lightning'){
  for(let i=0;i<3;i++){const flash=$('div','tw-thunder-flash',sc);flash.style.animationDelay=(i*330)+'ms';}
  for(let i=0;i<3;i++){const bolt=$('div','tw-bolt',sc);bolt.textContent='ϟ';set(bolt,{'--x':(25+i*25)+'%','--delay':(i*340)+'ms'});}
  for(let i=0;i<15;i++)particle(sc,'tw-spark','✧',30+rand(i,1)*40,48,(rand(i,2)-.5)*440,(rand(i,3)-.5)*220,300+i*35,1350);
 }
 if(s.scene==='diamonds'){
  for(let i=0;i<25;i++)particle(sc,'tw-crystal',['◆','◇','💎'][i%3],rand(i,1)*100,110+rand(i,2)*25,(rand(i,3)-.5)*95,-200-rand(i,4)*280,i*67,2350+rand(i,5)*900,rand(i,6)*160);
  $ ('div','tw-crystal-halo',sc);
 }
 if(s.scene==='crowns'){
  const halo=$('div','tw-royal-halo',sc);halo.textContent='✦';
  const crown=$('div','tw-royal-crown',sc);crown.textContent='👑';
  for(let i=0;i<22;i++)particle(sc,'tw-gold-spark','✦',rand(i,1)*100,rand(i,2)*100,(rand(i,3)-.5)*80,-30,i*85,1500);
 }
 if(s.scene==='supernova'){
  for(let i=0;i<5;i++){let ring=$('div','tw-cosmos-ring',sc);ring.style.animationDelay=(i*240)+'ms';}
  const core=$('div','tw-cosmos-core',sc);core.textContent='✹';
  for(let i=0;i<52;i++){let ang=2*Math.PI*i/52;particle(sc,'tw-cosmos-particle',i%4?'✦':'✧',50,48,Math.cos(ang)*(125+rand(i,4)*260),Math.sin(ang)*(125+rand(i,5)*260),i*25,2700,i*67);}
 }
 if(s.scene==='dragon'){
  const flame=$('div','tw-dragon-flame',sc);
  const dragon=$('div','tw-dragon',sc);dragon.textContent='🐉';
  for(let i=0;i<29;i++)particle(sc,'tw-ember',['🔥','✦','•'][i%3],5+rand(i,1)*90,60+rand(i,2)*35,100+rand(i,3)*240,-70-rand(i,4)*260,i*72,2100+rand(i,5)*600);
 }
 if(s.scene==='rainbow'){
  const bow=$('div','tw-rainbow-arc',sc);
  const glow=$('div','tw-rainbow-glow',sc);glow.textContent='🌈';
  for(let i=0;i<35;i++)particle(sc,'tw-rainbow-dot','✧',rand(i,1)*100,95+rand(i,2)*12,(rand(i,3)-.5)*150,-220-rand(i,4)*210,i*63,2050);
 }
 if(s.scene==='fireworks'){
  [['23','32','#fbbf24'],['78','28','#f472b6'],['50','55','#67e8f9'],['30','69','#c4b5fd'],['72','67','#fda4af']].forEach(([x,y,c])=>arcs(sc,+x,+y,17,c));
  for(let i=0;i<10;i++){let o=$('span','tw-firework-glitter',sc);o.textContent='✦';set(o,{'--x':rand(i,1)*100+'%','--y':rand(i,2)*85+'%','--delay':i*140+'ms'});}
 }
 const banner=$('div','tw-banner tw-banner-'+s.scene,sc);
 const small=$('small','',banner);small.textContent='✦ 정답 달성 ✦';
 const head=$('strong','',banner);head.textContent=s.title;
 const sub=$('em','',banner);sub.textContent=s.sub;
 if(reduce)sc.classList.add('tw-reduced');
}
function play(id){
 const layer=document.getElementById('victoryEffect');if(!layer)return;
 if(cleanup){clearTimeout(cleanup);cleanup=null;}
 layer.replaceChildren();const s=STYLES[id]||STYLES['fx:confetti'];
 build(layer,s,window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 cleanup=setTimeout(()=>{layer.replaceChildren();cleanup=null;},s.duration);
}
window.TodaywordVictory=Object.freeze({play,styles:STYLES});
})();
