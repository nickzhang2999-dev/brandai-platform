
function openModal(title, body, textarea=false){
  const mask=document.querySelector('.modal-mask');
  const box=document.querySelector('.modal');
  box.querySelector('h3').textContent=title;
  const content=textarea ? `<textarea placeholder="${body}"></textarea>` : `<p>${body}</p>`;
  box.querySelector('.modal-content').innerHTML=content;
  mask.style.display='flex';
}
function closeModal(){document.querySelector('.modal-mask').style.display='none';}
document.addEventListener('click', function(e){
  const action=e.target.closest('[data-modal]');
  if(action){
    openModal(action.dataset.modal, action.dataset.body || '该操作为 HTML 静态原型中的模拟交互。', action.dataset.textarea==='true');
  }
  const close=e.target.closest('[data-close]');
  if(close){ closeModal(); }
  if(e.target.classList.contains('modal-mask')) closeModal();
  const project=e.target.closest('.project-card');
  if(project){
    document.querySelectorAll('.project-card').forEach(x=>x.classList.remove('active'));
    project.classList.add('active');
    const title=project.dataset.title;
    const summary=project.dataset.summary;
    const panel=document.querySelector('.ai-panel');
    if(panel){
      panel.querySelector('h3').textContent='AI 项目摘要 · ' + title;
      panel.querySelector('p').textContent=summary;
    }
  }
  const asset=e.target.closest('.asset-card');
  if(asset){
    document.querySelectorAll('.asset-card').forEach(x=>x.classList.remove('active'));
    asset.classList.add('active');
    const panel=document.querySelector('.detail-panel');
    if(panel){
      panel.querySelector('.detail-title').textContent=asset.dataset.name;
      panel.querySelector('.detail-desc').textContent=asset.dataset.desc;
      panel.querySelector('.detail-type').textContent=asset.dataset.type;
      panel.querySelector('.detail-size').textContent=asset.dataset.size;
    }
  }
  const variant=e.target.closest('.variant');
  if(variant){
    document.querySelectorAll('.variant').forEach(x=>x.classList.remove('active'));
    variant.classList.add('active');
    const art=document.querySelector('.ad-art h1');
    if(art){ art.textContent=variant.dataset.title || '初夏焕亮'; }
  }
  const submit=e.target.closest('[data-generate]');
  if(submit){
    const old=submit.textContent;
    submit.textContent='AI 正在生成...';
    submit.disabled=true;
    setTimeout(()=>{ submit.textContent='生成完成 ✓'; setTimeout(()=>{submit.textContent=old; submit.disabled=false;},1200);},1200);
  }
});
