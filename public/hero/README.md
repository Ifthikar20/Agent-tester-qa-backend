# Hero images

Drop `.jpg`, `.png`, `.webp` or `.avif` files in here and the hero panels use
them as a backdrop. Nothing here is fine — the panels fall back to the gradient.

The list is read per request, so adding files needs a page reload and not a
server restart. Each page picks one deterministically from the sorted list, so
a page keeps the same picture and two pages side by side do not show the same
one.

Text sits on a scrim of solid panel colour that fades into the picture, so
legibility does not depend on which image you chose. Keep them reasonably
sized: they are served as-is, and a 6MB photograph is a 6MB photograph.
