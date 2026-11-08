import { InspirationId } from '@brandai/contracts';
import { ApiException } from '../api';

/** Selection only. Every caller must still resolve this ID within the workspace owner. */
export function requestedLibraryId(request: Request): string | undefined {
  const values = new URL(request.url).searchParams.getAll('libraryId');
  if (!values.length) return undefined;
  if (values.length !== 1) throw new ApiException(422, '灵感库标识不能重复。');
  const parsed = InspirationId.safeParse(values[0]);
  if (!parsed.success) throw new ApiException(422, '灵感库标识无效。');
  return parsed.data;
}
