# lm_head argmax with a pre-created landscape (per-token group norms), Qwen2.5-0.5B.
import sys, numpy as np
R='/home/ubuntu/environment/mc-inference-paper/Monte-Carlo-AI-Inference/forGithub'
sys.path.insert(0, R+'/llama.cpp/gguf-py')
from gguf import GGUFReader
from gguf.quants import dequantize
G=int(sys.argv[1]); NT=int(sys.argv[2])
t=[t for t in GGUFReader(R+'/work/models/qwen2.5-0.5b-q4km.gguf').tensors if t.name=='token_embd.weight'][0]
d,V=int(t.shape[0]),int(t.shape[1]); bpw={'Q8_0':8.5,'Q6_K':6.5625,'Q4_K':4.5,'Q5_0':5.5,'F16':16}[t.tensor_type.name]
E=np.asarray(dequantize(t.data,t.tensor_type),dtype=np.float32).reshape(V,d)
H=np.fromfile(R+'/work/cv/dump_head/token_embd.weight.f32',dtype=np.float32).reshape(-1,d)[1:]
H=H[np.linspace(0,len(H)-1,NT).astype(int)]
ng=d//G; Eg=E.reshape(V,ng,G)
L=np.sqrt((Eg*Eg).sum(2))                      # landscape: V x ng group norms (stored f16)
colF=np.sqrt((L*L).sum(0))
full=V*d*bpw/8; land=V*ng*2
print(f'lm_head {V}x{d} {t.tensor_type.name}, G={G} ({ng} groups), landscape = {land/full:.1%} of lm_head bytes, tokens={NT}')
def run_bb(h, c):
    """c=None: exact Cauchy-Schwarz bounds; c=float: probabilistic bound c*sigma (MC landscape)."""
    hg=h.reshape(ng,G); hn=np.sqrt((hg*hg).sum(1)); order=np.argsort(-(hn*colF))
    alive=np.arange(V); P=np.zeros(V,np.float32); read=0
    if c is None: rem=L@hn                       # sum_g ||E_vg|| ||h_g||
    else:         rem=(L*L)@(hn*hn)/G            # variance if directions random
    for g in order:
        P[alive]+=Eg[alive,g,:]@hg[g]; read+=len(alive)*G
        if c is None: rem[alive]-=L[alive,g]*hn[g]; b=np.maximum(rem[alive],0)
        else:         rem[alive]-=(L[alive,g]*hn[g])**2/G; b=c*np.sqrt(np.maximum(rem[alive],0))
        lo=(P[alive]-b).max(); alive=alive[P[alive]+b>=lo]
        if len(alive)==1: break
    return alive[np.argmax(P[alive])], read*bpw/8
def run_two_stage(h, f, C):
    hg=h.reshape(ng,G); hn=np.sqrt((hg*hg).sum(1)); top=np.argsort(-(hn*colF))[:max(1,round(f*ng))]
    approx=np.einsum('vgk,gk->v',Eg[:,top,:],hg[top]); cand=np.argpartition(-approx,C)[:C]
    return cand[np.argmax(E[cand]@h)], (V*len(top)*G + C*d)*bpw/8
Z=H@E.T; truth=Z.argmax(1)
def report(name, fn, with_land):
    ok=0; rd=0
    for i,h in enumerate(H):
        a,r=fn(h); ok+=a==truth[i]; rd+=r
    print(f'  {name:34s} top-1 agreement {ok/len(H):6.1%}   read {(rd/len(H)+(land if with_land else 0))/full:6.1%} of lm_head', flush=True)
report('A exact branch&bound', lambda h: run_bb(h,None), True)
for c in (4,3,2):
    report(f'B MC bound c={c}', lambda h,c=c: run_bb(h,c), True)
for f,C in ((0.1,64),(0.2,64),(0.3,256),(0.5,256)):
    report(f'C two-stage top {f:.0%} groups + {C} exact', lambda h,f=f,C=C: run_two_stage(h,f,C), False)
