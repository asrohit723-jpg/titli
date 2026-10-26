'use strict';
// Where the panel opens: right under the menu-bar icon on a Mac, right above (or beside) the
// tray icon on Windows, whichever edge the taskbar is on. Pure, so it's tested on its own.

const MARGIN = 8;

function panelBounds({ tray, work, width, height, platform }) {
  const hasTray = !!(tray && tray.width > 0 && tray.height > 0);
  const right = work.x + work.width, bottom = work.y + work.height;
  const h = Math.min(height, work.height - MARGIN * 2);
  const cx = hasTray ? tray.x + tray.width / 2 : right - width / 2 - MARGIN;
  const cy = hasTray ? tray.y + tray.height / 2 : (platform === 'darwin' ? work.y - 1 : bottom + 1);
  let x, y;
  if (platform === 'darwin' || cy < work.y) {          // menu bar or a taskbar along the top
    x = cx - width / 2; y = work.y + (platform === 'darwin' ? 6 : MARGIN);
  } else if (cy > bottom) {                            // taskbar along the bottom (the usual)
    x = cx - width / 2; y = bottom - h - MARGIN;
  } else if (cx < work.x) {                            // taskbar on the left
    x = work.x + MARGIN; y = cy - h + 24;
  } else if (cx > right) {                             // taskbar on the right
    x = right - width - MARGIN; y = cy - h + 24;
  } else {                                             // icon tucked in the overflow area: bottom right
    x = right - width - MARGIN; y = bottom - h - MARGIN;
  }
  x = Math.round(Math.max(work.x + MARGIN, Math.min(x, right - width - MARGIN)));
  y = Math.round(Math.max(work.y + (platform === 'darwin' ? 6 : MARGIN), Math.min(y, bottom - h - MARGIN)));
  return { x, y, width, height: h };
}

module.exports = { panelBounds };
