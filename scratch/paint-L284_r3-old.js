  if (gridChanged) {
    paintCtx.save();
    if (paintClip) paintCtx.clip(paintClip);
    paintCtx.fillStyle = f.css;
    paintCtx.globalAlpha = 1;
    drawOrganicSplat(paintCtx, cx, cz, r);
    paintCtx.restore();
    clipPaintToIsland();
    paintDirty = true;
  }
}