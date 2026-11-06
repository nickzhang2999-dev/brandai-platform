import {prisma} from '@brandai/db';
/** Call only after getCase has checked current membership, revision and withdrawal. */
export async function readInspirationImage(row:{libraryId:string;releaseId:string},path:string,activeRelease?:string,snapshot=false) {
  const legacy=await prisma.inspirationImage.findUnique({where:{libraryId_releaseId_path:{libraryId:row.libraryId,releaseId:row.releaseId,path}}});
  if(legacy)return legacy;
  if(!snapshot)return null;
  const {getSnapshotObject}=await import('./snapshot-import');
  const object=await getSnapshotObject(row.libraryId,activeRelease??row.releaseId,path);
  return object?{mimeType:object.mime,sha256:object.sha256,bytes:object.bytes}:null;
}
