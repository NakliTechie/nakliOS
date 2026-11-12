// Copied from Ductella (MIT) src/booleans.js at commit b0d5a3c (github.com/NakliTechie/ductella): path
// booleans on path-bool 1.0.4 (MIT, Adam Platkevič; vendored at vendor/path-bool). Only the import paths
// changed. Atelier op names map onto Ductella's: union → unite, subtract → minus-front (the bottom path
// minus every path above it), intersect, exclude.

// Path booleans and Shape Builder on top of path-bool (MIT), using the
// Ductella path model from geom.js. Results keep cubic segments.

import {
  PathBoolean,
  PathBooleanOperation,
  FillRule,
  pathFromPathData,
  pathToPathData,
} from '../../vendor/path-bool/path-bool.js';
import { writePath, parsePath, flatten } from './geom.js';

const OPS = {
  unite: PathBooleanOperation.Union,
  'minus-front': PathBooleanOperation.Difference,
  intersect: PathBooleanOperation.Intersection,
  exclude: PathBooleanOperation.Exclusion,
  // path-bool's Division only cuts the first shape; Fracture returns every covered face,
  // which is Illustrator's Divide.
  divide: PathBooleanOperation.Fracture,
};

/** Every subpath is treated as filled, so close them before handing over. */
function toPB(model) {
  const closed = model.filter((sp) => sp.anchors.length > 1).map((sp) => ({ closed: true, anchors: sp.anchors }));
  return pathFromPathData(writePath(closed, 12));
}

/** path-bool returns closed loops without Z; turn each loop into a closed subpath. */
export function fromPB(path) {
  const d = pathToPathData(path);
  const model = parsePath(d);
  for (const sp of model) {
    const a = sp.anchors;
    if (!sp.closed && a.length > 1) {
      const f = a[0], l = a[a.length - 1];
      const tol = 1e-7 * Math.max(1, Math.abs(f.x), Math.abs(f.y));
      if (Math.abs(f.x - l.x) <= tol && Math.abs(f.y - l.y) <= tol) {
        f.hIn = l.hIn;
        a.pop();
      }
    }
    sp.closed = true;
  }
  return model.filter((sp) => sp.anchors.length > 1);
}

function inputsToPB(inputs) {
  return inputs.map(({ model, fillRule }) => ({
    path: toPB(model || []),
    fillRule: fillRule === 'evenodd' ? FillRule.EvenOdd : FillRule.NonZero,
  }));
}

const nonEmpty = (m) => (m || []).some((sp) => sp.anchors.length > 1);

/**
 * Illustrator-style booleans. inputs are in paint order, bottom first.
 * Returns a Model; for 'divide' returns Model[] (one per face).
 */
export function boolean(op, inputs) {
  const code = OPS[op];
  if (code === undefined) throw new Error(`unknown boolean op: ${op}`);
  let list = inputs || [];
  if (op === 'unite' || op === 'divide' || op === 'exclude') list = list.filter((x) => nonEmpty(x.model));
  if (op === 'intersect' && list.some((x) => !nonEmpty(x.model))) return [];
  if (op === 'minus-front') {
    if (!list.length || !nonEmpty(list[0].model)) return [];
    list = [list[0], ...list.slice(1).filter((x) => nonEmpty(x.model))];
  }
  if (!list.length) return op === 'divide' ? [] : [];
  const pb = new PathBoolean(inputsToPB(list));
  const result = pb.get(code);
  if (op === 'divide') return result.map(fromPB).filter((m) => m.length);
  return result.flatMap(fromPB);
}

function pointInModel(model, p) {
  // even-odd test on a flattening; faces are simple regions (holes as extra loops)
  let inside = false;
  for (const poly of flatten(model, 0.05)) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Shape Builder: the planar faces of the inputs, a merge of chosen faces, and a face lookup. */
export function shapeBuilder(inputs) {
  const list = (inputs || []).filter((x) => nonEmpty(x.model));
  if (!list.length) return { faces: [], merge: () => [], faceAt: () => -1 };
  const pb = new PathBoolean(inputsToPB(list));
  const faces = pb.getFaces().map(fromPB);
  return {
    faces,
    merge(indices) {
      const idx = [...indices].filter((k) => k >= 0 && k < faces.length);
      if (!idx.length) return [];
      return fromPB(pb.buildShape(idx));
    },
    faceAt(p) {
      for (let k = 0; k < faces.length; k++) if (pointInModel(faces[k], p)) return k;
      return -1;
    },
  };
}
