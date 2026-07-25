  if (gridChanged) {
    paintCtx.save();
    paintCtx.fillStyle = colorStr;
    drawOrganicSplat(paintCtx, cx, cz, r);
    paintCtx.restore();
    clipPaintToIsland();
    paintDirty = true;
  }
}