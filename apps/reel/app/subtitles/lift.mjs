/* Keeping subtitles clear of the visible control bar (promo-capture defect 1).
 *
 * The shell publishes how many stage pixels the visible control bar covers: the CSS property
 * `--reel-controls-inset` on #player and the `ui:controls` { visible, insetPx } event. Subtitles
 * draw inside the picture rect (the caption layer), so only the part of the inset that reaches
 * into the picture matters: a letterbox bar under the picture absorbs the rest.
 *
 * Text captions move up by that overlap. Styled ASS (JASSUB) and PGS bitmaps arrive as a list of
 * drawn boxes; the boxes of the bottom group (lines anchored low on the picture) move up together,
 * by the part of the overlap that reaches their lowest drawn row, and boxes anchored at the top
 * stay where the file put them. Moving boxes keeps their size and their positions relative to each
 * other, which shrinking the render area would not: libass and PGS both scale to the frame height.
 *
 * Pure functions only, so test/subtitles.test.mjs runs them in Node. */

/* Space kept between a lifted bitmap line and the top of the bar, as a fraction of picture height. */
export const LIFT_GAP = 0.02;

/* Pixels of the picture rect (top `pictureTop`, height `pictureHeight`, both in stage pixels)
 * that a bar covering the lowest `insetPx` of a stage `stageHeight` tall reaches into. */
export function insetOverlap(stageHeight, pictureTop, pictureHeight, insetPx) {
  const inset = Number(insetPx);
  if (!(inset > 0) || !(stageHeight > 0) || !(pictureHeight > 0)) return 0;
  const below = stageHeight - (pictureTop + pictureHeight);
  return Math.min(pictureHeight, Math.max(0, inset - Math.max(0, below)));
}

/* Reads a CSS length in px ("84px", "84", " 84.5px "); anything else is 0. */
export function parseInset(value) {
  const number = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/* The boxes that belong to the bottom group: every box whose centre is in the lower half, plus
 * any box that touches the group from above (the upper lines of a tall bottom event). */
export function bottomGroup(boxes, height) {
  const inGroup = boxes.map(box => box.y + box.h / 2 > height / 2);
  let top = Infinity;
  for (let i = 0; i < boxes.length; i += 1) if (inGroup[i]) top = Math.min(top, boxes[i].y);
  if (top === Infinity) return inGroup;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < boxes.length; i += 1) {
      if (inGroup[i]) continue;
      const box = boxes[i];
      if (box.y + box.h >= top - box.h * 0.25) {
        inGroup[i] = true;
        top = Math.min(top, box.y);
        changed = true;
      }
    }
  }
  return inGroup;
}

/* How far to move the bottom group up so its lowest drawn row ends `gap` above `clearY`.
 * boxes: [{ y, h }] in the same units as height and clearY (canvas pixels). The lift never takes
 * the group above the top of the canvas. Returns { lift, moved: boolean[] }. */
export function liftBoxes(boxes, height, clearY, gap = LIFT_GAP * height) {
  const none = { lift: 0, moved: boxes.map(() => false) };
  if (!boxes.length || !(height > 0) || !(clearY < height)) return none;
  const moved = bottomGroup(boxes, height);
  let lowest = -Infinity;
  let highest = Infinity;
  for (let i = 0; i < boxes.length; i += 1) {
    if (!moved[i]) continue;
    lowest = Math.max(lowest, boxes[i].y + boxes[i].h);
    highest = Math.min(highest, boxes[i].y);
  }
  if (lowest === -Infinity) return none;
  const lift = Math.min(Math.max(0, highest), Math.max(0, lowest - (clearY - gap)));
  return lift > 0 ? { lift, moved } : none;
}
