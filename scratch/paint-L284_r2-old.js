  if (gridChanged) {
    paintCtx.save();
    if (paintClip) paintCtx.clip(paintClip);
    paintCtx.fillStyle = colorStr;
    drawOrganicSplat(paintCtx, cx, cz, r);
    paintCtx.restore();
    clipPaintToIsland();
    paintDirty = true;
  }
}