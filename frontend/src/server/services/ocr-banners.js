import { createCanvas } from "@napi-rs/canvas";

/** Recover light text on saturated horizontal banners without changing page coordinates. */
export function bannerMask(canvas) {
  const {width,height}=canvas;
  const pixels=canvas.getContext("2d").getImageData(0,0,width,height).data;
  const saturated=(index)=> {
    const r=pixels[index],g=pixels[index+1],b=pixels[index+2];
    return Math.max(r,g,b)-Math.min(r,g,b)>75 && Math.min(r,g,b)<160;
  };
  const rows=[];
  for(let y=0;y<height;y++) {
    let count=0;for(let x=0;x<width;x+=2)if(saturated((y*width+x)*4))count+=2;
    if(count>width*.17)rows.push(y);
  }
  const ranges=[];
  for(const y of rows) {
    const last=ranges.at(-1);if(last && y<=last[1]+2)last[1]=y;else ranges.push([y,y]);
  }
  const bands=[];
  for(const [top,bottom] of ranges) {
    const h=bottom-top+1;
    if(h<8 || h>height*.07)continue;
    const spans=[];
    for(let x=0;x<width;x+=2) {
      let count=0;for(let y=top;y<=bottom;y+=2)if(saturated((y*width+x)*4))count+=2;
      if(count<h*.55)continue;
      const last=spans.at(-1);if(last && x-last[1]<width*.02)last[1]=x+2;else spans.push([x,x+2]);
    }
    for(const [left,right] of spans)if(right-left>width*.17)bands.push({left,right:Math.min(width,right),top,bottom:bottom+1});
  }
  if(!bands.length)return null;
  const mask=createCanvas(width,height),context=mask.getContext("2d");
  context.fillStyle="white";context.fillRect(0,0,width,height);
  for(const band of bands) {
    const w=band.right-band.left,h=band.bottom-band.top, patch=context.createImageData(w,h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
      const source=((y+band.top)*width+x+band.left)*4,index=(y*w+x)*4;
      const value=pixels[source]+pixels[source+1]+pixels[source+2]>630 ? 0:255;
      patch.data[index]=patch.data[index+1]=patch.data[index+2]=value;patch.data[index+3]=255;
    }
    context.putImageData(patch,band.left,band.top);
  }
  return {canvas:mask,bands};
}
