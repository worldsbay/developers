import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicWorldSchema } from '../packages/core/registry.js';
import { avatarWorlds } from '../packages/ui/avatar-worlds.js';
import { loadAvatar } from '../packages/three/avatar.js';
import type { Appearance, World } from '../packages/core/contract.js';
test('registry and world picture indicators preserve both, neither and unspecified support',()=>{
 const base={id:'example',name:'Example',url:'https://example.com',entryPath:'/enter',accent:'#abcdef',description:''};
 for(const support of [undefined,[],['low-poly'],['detailed'],['low-poly','detailed']]) {
  const world=publicWorldSchema.parse({...base,avatarSupport:support});
  assert.deepEqual(world.avatarSupport,support);
 }
 const world=publicWorldSchema.parse({...base,avatarSupport:['low-poly']});
 assert.match(avatarWorlds([world],'low-poly'),/Example: Supported/);
 assert.match(avatarWorlds([world],'detailed'),/Example: Other style only/);
 assert.match(avatarWorlds([{...world,avatarSupport:undefined}],'detailed'),/Not specified/);
});
test('shared renderer refuses unsupported personal assets before issuing any model request',async()=>{
 const appearance={avatarSupported:false,bodyAsset:'https://must-not-be-loaded.example/model.glb'} as Appearance;
 await assert.rejects(loadAvatar(appearance),/own avatar/);
});
