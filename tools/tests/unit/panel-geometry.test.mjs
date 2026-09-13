import {test} from 'node:test';
import assert from 'node:assert/strict';
import {constrainRect,resizeRect} from '../../../src/ui/panel-geometry.js';

test('窗口在拖动和四角缩放后仍处于视口',()=>{
 const viewport={width:800,height:600};
 const rect=constrainRect({left:900,top:-20,width:510,height:780},viewport);
 assert.deepEqual(rect,{left:280,top:10,width:510,height:580});
 const small=resizeRect(rect,'nw',900,900,viewport);
 assert.equal(small.width,360);
 assert.equal(small.height,480);
});

test('东南方向扩展受剩余视口约束',()=>{
 assert.deepEqual(resizeRect({left:100,top:50,width:400,height:500},'se',500,500,{width:800,height:700}),{
  left:100,top:50,width:690,height:640,
 });
});
