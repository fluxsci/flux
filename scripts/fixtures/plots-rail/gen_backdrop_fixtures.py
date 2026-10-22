import matplotlib; matplotlib.use("svg")
import matplotlib.pyplot as plt, numpy as np
plt.rcParams["svg.fonttype"]="none"
rng=np.random.default_rng(1); x=np.linspace(0,10,80)
def save(fig,name): fig.savefig(f"/tmp/p0/trans/{name}.svg",transparent=True,bbox_inches="tight"); plt.close(fig)
# 1 light theme transparent
fig,ax=plt.subplots(figsize=(3,2)); ax.plot(x,np.sin(x),color="#205EA6"); ax.grid(color="#E6E4D9"); ax.set_title("Light theme"); save(fig,"light")
# 2 dark theme: white ink
with plt.rc_context({"text.color":"white","axes.labelcolor":"white","xtick.color":"white","ytick.color":"white","axes.edgecolor":"white"}):
    fig,ax=plt.subplots(figsize=(3,2)); ax.plot(x,np.cos(x),color="#F2F0E5"); ax.set_title("Dark theme"); save(fig,"dark")
# 3 seaborn-ish: white axes facecolor, transparent fig, dark ticks
fig,ax=plt.subplots(figsize=(3,2)); fig.patch.set_alpha(0); ax.set_facecolor("white"); ax.plot(x,x**.5,color="#AF3029"); ax.set_title("Seaborn style")
fig.savefig("/tmp/p0/trans/seaborn.svg",transparent=False,facecolor=(0,0,0,0),bbox_inches="tight"); plt.close(fig)
# 4 white title + black ticks (mixed)
fig,ax=plt.subplots(figsize=(3,2)); ax.plot(x,np.sin(x)*x,color="black"); ax.set_title("WHITE TITLE",color="white"); save(fig,"mixed")
# 5 colourful scatter only, no text
fig,ax=plt.subplots(figsize=(3,2)); ax.scatter(rng.random(200),rng.random(200),c=rng.choice(["#AF3029","#205EA6","#66800B","#AD8301","#5E409D"],200),s=8); ax.axis("off"); save(fig,"colour_scatter")
# 6 yellow + light grey only (light ink, no black)
fig,ax=plt.subplots(figsize=(3,2)); ax.bar(range(6),rng.random(6),color="#D0A215"); ax.axis("off"); save(fig,"yellow_bars")
# 7 base-50 panel on transparent fig with black text
fig,ax=plt.subplots(figsize=(3,2)); ax.set_facecolor("#F2F0E5"); ax.plot(x,np.sin(x),color="#100F0F"); save(fig,"base50_panel")
# 8 opaque white background
fig,ax=plt.subplots(figsize=(3,2)); ax.plot(x,np.sin(x)); fig.savefig("/tmp/p0/trans/opaque.svg",bbox_inches="tight"); plt.close(fig)
# 9 tiny white text only on transparent (hard case)
fig=plt.figure(figsize=(2,1)); fig.text(.1,.5,"p = 0.003",color="white",fontsize=7); save(fig,"white_text_only")
# 10 halo markers: translucent blue faces with white rims on a transparent light plot
fig,ax=plt.subplots(figsize=(3,2)); ax.plot(x,x*.3,color="#205EA6",lw=1); ax.scatter(x[::6],x[::6]*.3,s=60,color="#4385BE",alpha=.8,edgecolors="white",linewidths=1.5,zorder=3); ax.set_title("Halo markers"); save(fig,"halo_markers")
# 11 white standalone points + black axes (genuinely white elements)
fig,ax=plt.subplots(figsize=(3,2)); ax.scatter(rng.random(150),rng.random(150),s=6,color="white"); ax.set_title("White points",color="black"); save(fig,"white_points")
