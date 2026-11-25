import {test,expect} from "@playwright/test";
import {objectMatrix,multiplyAffine} from "../../src/render/rigCanvas";
import {createDemoPreset} from "../../src/data/demoPreset";
import {NEUTRAL_PARAMS} from "../../src/engine/frame";
test("expanded affine matches matrix composition with skew, mirrors and zero scale",()=>{
  const object=createDemoPreset().objects[0];
  for(let i=0;i<200;i++){
    const base={...object.base,x:i-100,y:100-i,rotation:i*7,skewX:(i%70)-35,skewY:(i%50)-25,sizeX:i%3-1,sizeY:i%5-2};
    const values={...NEUTRAL_PARAMS,x:i/3,y:-i/7,rotation:-i*3,skewX:i%20,skewY:-i%15,sizeX:1.3,sizeY:-.7};
    const r=(base.rotation+values.rotation)*Math.PI/180;
    const expected=multiplyAffine(multiplyAffine(multiplyAffine(
      {a:1,b:0,c:0,d:1,e:base.x+values.x,f:base.y+values.y},
      {a:Math.cos(r),b:Math.sin(r),c:-Math.sin(r),d:Math.cos(r),e:0,f:0}),
      {a:base.sizeX*values.sizeX,b:0,c:0,d:base.sizeY*values.sizeY,e:0,f:0}),
      {a:1,b:Math.tan((base.skewY+values.skewY)*Math.PI/180),c:Math.tan((base.skewX+values.skewX)*Math.PI/180),d:1,e:0,f:0});
    const actual=objectMatrix({...object,base},values);
    for(const key of ["a","b","c","d","e","f"] as const)expect(actual[key]).toBeCloseTo(expected[key],10);
  }
});
