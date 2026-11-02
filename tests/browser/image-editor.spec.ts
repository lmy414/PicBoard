import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('http://127.0.0.1:5173/tests/browser/editor.html'); });

test('crop, rotation and flip preserve exact pixel locations', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderImageEdits } = await import('/renderer/src/pages/image-editing.ts');
    const source = document.createElement('canvas'); source.width = 4; source.height = 3;
    const context = source.getContext('2d')!;
    context.fillStyle = '#ff0000'; context.fillRect(1, 0, 1, 1);
    context.fillStyle = '#0000ff'; context.fillRect(2, 1, 1, 1);
    const output = renderImageEdits(source, 4, 3, [{kind:'crop',rect:{x:1,y:0,width:2,height:2}},{kind:'rotate'},{kind:'flip'}]);
    const pixels = output.getContext('2d')!;
    return {width:output.width,height:output.height,red:Array.from(pixels.getImageData(0,0,1,1).data),blue:Array.from(pixels.getImageData(1,1,1,1).data)};
  });
  expect(result).toEqual({width:2,height:2,red:[255,0,0,255],blue:[0,0,255,255]});
});

test('mosaic changes only the selected area and exports valid PNG JPEG and WebP', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderImageEdits, encodeImage } = await import('/renderer/src/pages/image-editing.ts');
    const source=document.createElement('canvas');source.width=8;source.height=8;
    const context=source.getContext('2d')!;context.fillStyle='#ff0000';context.fillRect(0,0,8,8);
    for(let y=0;y<4;y++)for(let x=0;x<4;x++){context.fillStyle=(x+y)%2?'#ffffff':'#000000';context.fillRect(x,y,1,1)}
    const output=renderImageEdits(source,8,8,[{kind:'mosaic',rect:{x:0,y:0,width:4,height:4},size:8}]);
    const pixels=output.getContext('2d')!;
    const formats=[];
    for(const format of ['png','jpeg','webp'] as const){const encoded=await encodeImage(output,format,'source.png',.92);const blob=new Blob([encoded.data]);const bitmap=await createImageBitmap(blob);formats.push({format,width:bitmap.width,height:bitmap.height,bytes:encoded.data.length,name:encoded.name});bitmap.close()}
    return {a:Array.from(pixels.getImageData(0,0,1,1).data),b:Array.from(pixels.getImageData(3,3,1,1).data),outside:Array.from(pixels.getImageData(7,7,1,1).data),formats};
  });
  expect(result.a).toEqual(result.b);
  expect(result.a[0]).toBeGreaterThan(0);expect(result.a[0]).toBeLessThan(255);
  expect(result.outside).toEqual([255,0,0,255]);
  for(const image of result.formats){expect(image.width).toBe(8);expect(image.height).toBe(8);expect(image.bytes).toBeGreaterThan(0)}
  expect(result.formats.map(image=>image.name)).toEqual(['source-编辑.png','source-编辑.jpg','source-编辑.webp']);
});

test('editor crop, annotation, undo, text and save work through the visible controls', async ({ page }) => {
  await page.evaluate(async () => {
    const source=document.createElement('canvas');source.width=400;source.height=300;source.getContext('2d')!.fillRect(0,0,400,300);
    const blob=await new Promise<Blob>(resolve=>source.toBlob(value=>resolve(value!)));
    (window as any).mountImageEditor(Array.from(new Uint8Array(await blob.arrayBuffer())));
  });
  const canvas = page.getByLabel('图片编辑画布');
  await expect(page.getByRole('button',{name:'保存副本'})).toBeEnabled();
  const drag = async (tool: string) => {
    await page.getByRole('button',{name:tool,exact:true}).click();
    const box=(await canvas.boundingBox())!;
    await page.mouse.move(box.x+box.width*.2,box.y+box.height*.2);await page.mouse.down();await page.mouse.move(box.x+box.width*.8,box.y+box.height*.8,{steps:8});await page.mouse.up();
  };
  await drag('裁剪');await page.getByRole('button',{name:'应用裁剪'}).click();
  await expect(canvas).toHaveAttribute('width','240');await expect(canvas).toHaveAttribute('height','180');
  await drag('方框');await expect(page.getByRole('button',{name:'撤销',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'撤销',exact:true}).click();await page.getByRole('button',{name:'重做',exact:true}).click();
  await page.getByRole('button',{name:'文字',exact:true}).click();await page.getByRole('textbox',{name:'批注文字'}).fill('测试');await canvas.click({position:{x:20,y:20}});
  await page.getByRole('combobox',{name:'导出格式'}).selectOption('webp');
  await page.getByRole('button',{name:'保存副本'}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).saved)).toBe(true);
  const result=await page.evaluate(async()=>{const value=(window as any).savedImage;const bitmap=await createImageBitmap(new Blob([new Uint8Array(value.data)]));return {name:value.name,width:bitmap.width,height:bitmap.height,error:(window as any).editorError}});
  expect(result).toEqual({name:'原图-编辑.webp',width:240,height:180,error:undefined});
});

test('JPEG flattens transparency to white and cancel protects unsaved edits', async ({ page }) => {
  const background = await page.evaluate(async () => {
    const { encodeImage } = await import('/renderer/src/pages/image-editing.ts');
    const source = document.createElement('canvas'); source.width=20;source.height=20;
    const encoded = await encodeImage(source,'jpeg','transparent.png',1);
    const bitmap = await createImageBitmap(new Blob([encoded.data]));
    source.getContext('2d')!.drawImage(bitmap,0,0);
    return Array.from(source.getContext('2d')!.getImageData(10,10,1,1).data);
  });
  expect(background).toEqual([255,255,255,255]);
  await page.evaluate(async () => {
    const source=document.createElement('canvas');source.width=100;source.height=80;
    const blob=await new Promise<Blob>(resolve=>source.toBlob(value=>resolve(value!)));
    (window as any).mountImageEditor(Array.from(new Uint8Array(await blob.arrayBuffer())));
  });
  await expect(page.getByRole('button',{name:'保存副本'})).toBeEnabled();
  await page.getByRole('button',{name:'旋转',exact:true}).click();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.getByRole('alertdialog',{name:'放弃图片编辑'})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).cancelled)).toBeUndefined();
  await page.getByRole('button',{name:'继续编辑',exact:true}).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'放弃修改',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).cancelled)).toBe(true);
});
