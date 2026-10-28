/** Browser component journeys for explicit revision consent and the original failed-task retry binding. */
import { test, expect } from '@playwright/test';

test('重试绑定原失败任务，不跟随当前选择章节', async ({ page }) => {
  const posts: string[] = [];
  const job = { jobId:'failed-job', projectId:1, chapterId:10, jobType:'chapter_generation', status:'failed', progressStage:'generating_text', maxCharge:'200', settledAmount:'0', failureMessage:'风格优化失败', failure:{recoverable:true}, startedAt:new Date().toISOString(), completedAt:new Date().toISOString() };
  await page.route('**/api/jobs/**', async route => {
    const url=route.request().url();
    if(route.request().method()==='POST'){posts.push(new URL(url).pathname);await route.fulfill({json:{...job,jobId:'next-job',status:'running'}});}
    else await route.fulfill({json:url.endsWith('/calls')?[]:job});
  });
  await page.goto('/login');
  await page.evaluate(async () => {
    const {createApp,h}=await import('/node_modules/.vite/deps/vue.js');
    const {default:ElementPlus}=await import('/node_modules/.vite/deps/element-plus.js');
    const {default:Panel}=await import('/src/components/workspace/GenerationPanel.vue');
    const root=document.createElement('div');document.body.replaceChildren(root);
    createApp({render:()=>h(Panel,{projectId:1,chapter:{id:999,content:'other selected chapter'},onRegisterTrack:(fn:(id:string)=>void)=>fn('failed-job')})}).use(ElementPlus).mount(root);
  });
  await expect(page.getByRole('button',{name:'重试原任务',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'重试原任务',exact:true}).click();
  await expect.poll(()=>posts).toEqual(['/api/jobs/failed-job/retry']);
  await expect(page.getByText('本章未交付，失败免单')).toBeVisible();
});

test('顺序重写先展示范围与预算，确认后才派发', async ({ page }) => {
  const posts: string[]=[];
  let state: Record<string,unknown>|null=null;
  const plan={id:'revision-1',version:1,status:'awaiting_confirmation',projectId:1,startChapter:1,endChapter:3,completedChapters:0,totalChapters:3,chapters:[1,2,3].map(n=>({chapterId:n,chapterNumber:n,version:1,attempts:0,manual:false})),reasons:['资料变化可能沿前文因果传播'],perChapterFen:200,totalFen:2000,pauseCode:null,pauseReason:null};
  await page.route('**/api/projects/1/revisions**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(route.request().method()==='GET'){await route.fulfill({json:state?[state]:[]});return;}
    posts.push(path);state=path.endsWith('/confirm')?{...plan,version:2,status:'running'}:{...plan};await route.fulfill({json:state});
  });
  await page.goto('/login');
  await page.evaluate(async()=>{
    const {createApp,h}=await import('/node_modules/.vite/deps/vue.js');
    const {default:ElementPlus}=await import('/node_modules/.vite/deps/element-plus.js');
    const {default:Panel}=await import('/src/components/workspace/RevisionPanel.vue');
    const root=document.createElement('div');document.body.replaceChildren(root);
    createApp({render:()=>h(Panel,{projectId:1,chapters:[1,2,3].map(n=>({id:n,chapterNumber:n}))})}).use(ElementPlus).mount(root);
  });
  await page.getByRole('button',{name:'查看重写计划',exact:true}).click();
  await expect(page.getByText(/每章最高 ¥2.00/)).toBeVisible();
  expect(posts).toEqual(['/api/projects/1/revisions']);
  await page.getByRole('button',{name:'确认范围并顺序重写',exact:true}).click();
  await expect(page.getByText(/顺序重写中/)).toBeVisible();
  expect(posts).toEqual(['/api/projects/1/revisions','/api/projects/1/revisions/revision-1/confirm']);
});
