import sys, os
OUT = sys.argv[1]
INK, VIO = "#1c1917", "#7c3aed"
f = lambda v: f"{v:g}"

# ---------- symbol ----------
def symbol(eye_r=20, bar=(142,128,46,18), cx_eye=98, cy_eye=126):
    # head: 184x144 rounded rect, r=52; holes: round eye + cursor-bar eye (closed-eye wink)
    x,y,w,h = bar
    head = "M88 56h80a52 52 0 0 1 52 52v40a52 52 0 0 1-52 52H88a52 52 0 0 1-52-52v-40a52 52 0 0 1 52-52Z"
    eye = f"M{f(cx_eye)} {f(cy_eye-eye_r)}a{f(eye_r)} {f(eye_r)} 0 1 0 0 {f(2*eye_r)}a{f(eye_r)} {f(eye_r)} 0 1 0 0 {f(-2*eye_r)}Z"
    b = f"M{f(x)} {f(y)}h{f(w)}v{f(h)}h{f(-w)}Z"
    return head + eye + b

SYM      = symbol()
# small-size cut: bigger eye + thicker, slightly longer bar, bottoms aligned
SYM_SM   = symbol(eye_r=24, bar=(140,126,52,24), cx_eye=96, cy_eye=126)
# reversed (white on dark): irradiation makes holes look smaller -> open them a touch
SYM_REV  = symbol(eye_r=21, bar=(141,127,48,20))

def svg(vb, body, title="minibot logo"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"><title>{title}</title>{body}</svg>\n'
def p(d, fill): return f'<path fill-rule="evenodd" fill="{fill}" d="{d}"/>'

# ---------- wordmark (custom geometric, nonzero union: solids CW, holes CCW) ----------
XH, ST, ASC, OV = 100, 22, 140, 1.5
RO, RI = 42, 20                       # arch radii (n, m)
BR = XH/2 + OV                        # bowl outer radius (overshoot)
def rect(x, y0, x1, y1):              # y up-positive in letter space -> svg y = -y
    return f"M{f(x)} {f(-y1)}H{f(x1)}V{f(-y0)}H{f(x)}Z"
def circ(cx, cy, r, ccw=False):
    s = 0 if ccw else 1
    return f"M{f(cx)} {f(-cy-r)}A{f(r)} {f(r)} 0 1 {s} {f(cx)} {f(-cy+r)}A{f(r)} {f(r)} 0 1 {s} {f(cx)} {f(-cy-r)}Z"
def arch(x):                          # n-shape, width 2*RO
    cy = XH + OV - RO
    return (f"M{f(x)} 0V{f(-cy)}A{RO} {RO} 0 0 1 {f(x+2*RO)} {f(-cy)}V0H{f(x+2*RO-ST)}"
            f"V{f(-cy)}A{RI} {RI} 0 0 0 {f(x+ST)} {f(-cy)}V0Z")
def ring(cx):
    return circ(cx, XH/2, BR) + circ(cx, XH/2, BR-ST, ccw=True)

def wordmark():
    d, x = [], 0
    d.append(arch(x)); d.append(arch(x + 2*RO - ST)); x += 4*RO - ST          # m
    x += 24; d.append(rect(x, 0, x+ST, XH)); d.append(circ(x+ST/2, XH+30, 13)); x += ST   # i
    x += 24; d.append(arch(x)); x += 2*RO                                         # n
    x += 24; d.append(rect(x, 0, x+ST, XH)); d.append(circ(x+ST/2, XH+30, 13)); x += ST   # i
    x += 24; d.append(rect(x, 0, x+ST, ASC)); d.append(ring(x+BR)); x += 2*BR      # b
    x += 14; d.append(ring(x+BR)); x += 2*BR                                      # o
    x += 10; d.append(rect(x+14, 0, x+14+ST, 128)); d.append(rect(x, XH-ST, x+56, XH)); x += 56  # t
    return "".join(d), x
WM, WMW = wordmark()

def wm_group(tx, ty, s, fill):
    return f'<path transform="translate({f(tx)} {f(ty)}) scale({f(s)})" fill="{fill}" d="{WM}"/>'
def sym_group(tx, ty, s, fill, d=SYM):
    return f'<path transform="translate({f(tx)} {f(ty)}) scale({f(s)})" fill-rule="evenodd" fill="{fill}" d="{d}"/>'

def write(name, text):
    open(os.path.join(OUT, name), "w", encoding="utf-8").write(text)

# symbol files
write("minibot-symbol.svg",        svg("0 0 256 256", p(SYM, VIO)))
write("minibot-symbol-black.svg",  svg("0 0 256 256", p(SYM, "#000")))
write("minibot-symbol-small.svg",  svg("0 0 256 256", p(SYM_SM, VIO)))
write("minibot-symbol-reversed.svg", svg("0 0 256 256", p(SYM_REV, "#fff")))
write("minibot-wordmark.svg", svg(f"-4 {-ASC-4} {f(WMW+8)} {ASC+8}", f'<path fill="{INK}" d="{WM}"/>'))

# horizontal lockup: head height == ascender (140) -> s = 140/144; gap = 0.4 head height
def horizontal(sym_fill, wm_fill, d=SYM):
    s = 160/144; head_w = 184*s; gap = 60
    H = 256; base = (H + 160)/2           # head bottom sits on the baseline
    top = base - 160
    body = sym_group(-36*s + 0, top - 56*s, s, sym_fill, d) + wm_group(head_w + gap, base, 1, wm_fill)
    W = head_w + gap + WMW
    return svg(f"-24 0 {f(W+48)} {H}", body)
write("minibot-horizontal.svg",          horizontal(VIO, INK))
write("minibot-horizontal-black.svg",    horizontal("#000", "#000"))
write("minibot-horizontal-reversed.svg", horizontal("#fff", "#fff", SYM_REV))

# stacked lockup: head 184 wide on top, wordmark scaled to 1.1x head width below
def stacked(sym_fill, wm_fill, d=SYM):
    s_wm = 184*1.35/WMW; wm_w = WMW*s_wm
    W = max(wm_w, 184) + 48; cx = W/2
    head_top = 24; gap = 48
    base = head_top + 144 + gap + ASC*s_wm
    body = sym_group(cx-128, head_top-56, 1, sym_fill, d) + wm_group(cx - wm_w/2, base, s_wm, wm_fill)
    return svg(f"0 0 {f(W)} {f(base+24)}", body)
write("minibot-stacked.svg", stacked(VIO, INK))
write("minibot-stacked-reversed.svg", stacked("#fff", "#fff", SYM_REV))
print("wordmark width", WMW)
