import bundledCatalog from '../../shared/imageCatalog.json' with { type: 'json' };
import type { ImageCatalog } from '../../shared/images.ts';
import { parseCatalog } from './catalog.ts';

export function bundledImageCatalog(): ImageCatalog {
  return parseCatalog(bundledCatalog);
}
