/* ═══════════════════════════════════════════════════════════════════════
   Cairn 站点共享脚本（中文页面）
   1. 主题切换：任何 [data-theme-toggle] 元素切换 data-theme 并写入 localStorage；
      无手动选择时跟随系统变化。首屏预载脚本在各页 <head> 内联，防闪烁。
   2. 滚动显现：.rv 进入视口加 .in；IntersectionObserver 不可用时全量直显。
   ═══════════════════════════════════════════════════════════════════════ */
(function(){
const root=document.documentElement;

/* ── 主题切换 ── */
document.querySelectorAll('[data-theme-toggle]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const next=root.dataset.theme==='dark'?'light':'dark';
    root.dataset.theme=next;
    try{localStorage.setItem('cairn-theme',next)}catch(_){/* 隐私模式：本次会话内生效即可 */}
  });
});
const media=matchMedia('(prefers-color-scheme: dark)');
const onMedia=e=>{
  let stored=null;
  try{stored=localStorage.getItem('cairn-theme')}catch(_){/* 读不到视为无手动选择 */}
  if(stored!=='dark'&&stored!=='light')root.dataset.theme=e.matches?'dark':'light';
};
if(media.addEventListener)media.addEventListener('change',onMedia);

/* ── 滚动显现 ── */
const targets=document.querySelectorAll('.rv');
if('IntersectionObserver' in window){
  const io=new IntersectionObserver(es=>{
    es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}});
  },{threshold:.12});
  targets.forEach(el=>io.observe(el));
  /* 兜底：observer 从未触发（脚本加载晚于滚动、零高度目标等）时不留隐形内容 */
  setTimeout(()=>{targets.forEach(el=>el.classList.add('in'))},2600);
}else{
  targets.forEach(el=>el.classList.add('in'));
}
})();
