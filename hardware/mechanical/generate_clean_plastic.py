"""Deterministic, scratch-free labyrinth grain and metric OpenGL normals.

A narrow-band isotropic random field approximates a stripe-forming Turing
pattern. Its zero contours become rounded ridges; this is a spectral synthesis,
not a Gray-Scott simulation. One unique 350mm swatch covers every enclosure.
"""
from pathlib import Path
import json
import numpy as np
from PIL import Image

out=Path('output/clean-plastic');out.mkdir(exist_ok=True)
size=4096;span_mm=350.;wavelength_mm=.30;height_mm=.012
rng=np.random.default_rng(73191)
noise=rng.standard_normal((size,size),dtype=np.float32)
freq=np.fft.fftfreq(size,d=span_mm/size).astype(np.float32)
radius=np.sqrt(freq[:,None]**2+freq[None,:size//2+1]**2)
center=1/wavelength_mm
band=np.exp(-.5*((radius-center)/(center*.16))**2)
field=np.fft.irfft2(np.fft.rfft2(noise)*band,s=(size,size)).astype(np.float32)
field/=field.std()
# Smooth alternating ridges and valleys; no color wear or scratch modulation.
bump=(.5+.5*np.tanh(field*1.3)).astype(np.float32)
height=bump*height_mm
dx=(np.roll(height,-1,axis=1)-np.roll(height,1,axis=1))/(2*span_mm/size)
# PNG rows descend, whereas UV V ascends.
dy=-(np.roll(height,-1,axis=0)-np.roll(height,1,axis=0))/(2*span_mm/size)
normal=np.stack((-dx,-dy,np.ones_like(dx)),axis=-1)
normal/=np.linalg.norm(normal,axis=-1,keepdims=True)
Image.fromarray(np.round(bump*65535).astype(np.uint16)).save(out/'height.png')
Image.fromarray(np.round((normal*.5+.5)*255).astype(np.uint8)).save(out/'normal.png')
meta={'method':'narrow-band spectral Turing-like labyrinth','seed':73191,
      'pixels':size,'swatch_mm':span_mm,'nominal_wavelength_mm':wavelength_mm,
      'peak_to_valley_mm':height_mm,'normal_convention':'OpenGL tangent space',
      'color':'uniform black; no scratch/color-wear maps'}
(out/'material.json').write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps(meta))
