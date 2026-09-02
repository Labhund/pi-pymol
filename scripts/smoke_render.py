"""S1 smoke test: headless PyMOL render loop.

Fetch a structure, cartoon it, color by secondary structure, render.
Run: pymol -cq smoke_render.py
"""
import os

os.makedirs("scratch", exist_ok=True)

from pymol import cmd

cmd.fetch("1ubq", async_=0)  # ubiquitin, small and unambiguous
cmd.bg_color("white")
cmd.hide("everything")
cmd.show("cartoon", "1ubq")
cmd.spectrum("count", selection="1ubq")  # rainbow by residue index
cmd.orient("1ubq")
cmd.set("ray_opaque_background", 0)
cmd.ray(1024, 768)
cmd.png("scratch/ubq_cartoon.png", dpi=150)
print("RENDER-OK")
