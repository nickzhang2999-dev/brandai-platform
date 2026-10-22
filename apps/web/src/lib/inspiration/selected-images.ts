import { prisma } from '@brandai/db';
import sharp from 'sharp';
import { getCase } from './service';
import { PublishedCase, sha256 } from './protocol';
export type SelectedImage={caseId:string;imageId:string;revision:number};
export type ModelImage=SelectedImage & {mimeType:'image/jpeg';base64:string};
export async function loadSelectedImages(workspaceId:string,selected:SelectedImage[],signal:AbortSignal):Promise<ModelImage[]> {
  if(selected.length>2 || new Set(selected.map(i=>`${i.caseId}:${i.imageId}`)).size!==selected.length)throw new Error('选图数量无效。');
  const result:ModelImage[]=[];
  for(const ref of selected) {
    signal.throwIfAborted();const {row,case:c}=await getCase(workspaceId,ref.caseId,ref.revision);
    if(!c.analysisAllowed)throw new Error('所选案例未授权外部模型分析，可继续本地浏览。');
    const image=PublishedCase.parse(row.body).images.find(i=>i.image_id===ref.imageId);if(!image)throw new Error('选定图片已失效。');
    const stored=await prisma.inspirationImage.findUnique({where:{workspaceId_releaseId_path:{workspaceId,releaseId:row.releaseId,path:image.path}}});
    if(!stored || stored.bytes.byteLength>20*1024*1024 || sha256(Buffer.from(stored.bytes))!==stored.sha256)throw new Error('选定图片校验失败。');
    const data=await sharp(Buffer.from(stored.bytes),{limitInputPixels:40000000,failOn:'error'}).rotate().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer();
    signal.throwIfAborted();if(data.length>1024*1024)throw new Error('选定图片处理后仍过大。');
    result.push({...ref,mimeType:'image/jpeg',base64:data.toString('base64')});
  }
  return result;
}
