# Offline simulator of the MC matmul estimator with control variates, on dumped activations.
import sys, os, re, numpy as np
R='/home/ubuntu/environment/mc-inference-paper/Monte-Carlo-AI-Inference/forGithub'
sys.path.insert(0, R+'/llama.cpp/gguf-py')
from gguf import GGUFReader
from gguf.quants import dequantize
G=32
name=sys.argv[1]; budgets=[float(b) for b in sys.argv[2].split(',')]; ranks=[int(r) for r in sys.argv[3].split(',')]
t=[t for t in GGUFReader(R+'/work/models/qwen2.5-0.5b-q4km.gguf').tensors if t.name==name][0]
K,N=int(t.shape[0]),int(t.shape[1]); W=np.asarray(dequantize(t.data,t.tensor_type),dtype=np.float64).reshape(N,K)
X=np.fromfile(f'{R}/work/cv/dump/{name}.f32',dtype=np.float32).reshape(-1,K)[2:].astype(np.float64)  # drop warmup
half=(len(X)//1024)*512; Xc,Xe=X[:half],X[half:]
Y=Xe@W.T; ref2=(Y*Y).sum()
ng=K//G; rng=np.random.default_rng(1)
wbytes={'Q4_K':4.5,'Q5_0':5.5,'Q6_K':6.5625,'Q8_0':8.5}[t.tensor_type.name]/8*N*K
def gn(M): return np.sqrt((M.reshape(M.shape[0],ng,G)**2).sum(axis=(0,2)))
def est(Xs,C,b,e,sample=True):
    Rm=W if C is None else W-C; rn=gn(Rm); ne=round(e*ng); m=round(b*ng)-ne
    out=np.zeros((len(Xs),N))
    for i,x in enumerate(Xs):
        xg=x.reshape(ng,G); s=np.sqrt((xg*xg).sum(1))*rn; order=np.argsort(-s,kind='stable')
        E=order[:ne]; rest=order[ne:]
        xE=np.zeros(K); 
        for g in E: xE[g*G:(g+1)*G]=x[g*G:(g+1)*G]
        y=W@xE
        if C is not None: y+=C@(x-xE)
        if sample and m>0:
            p=s[rest]; tot=p.sum()
            if tot>0:
                cnt=np.bincount(rng.choice(len(rest),size=m,p=p/tot),minlength=len(rest))
                xt=np.zeros(K)
                for j in np.nonzero(cnt)[0]:
                    g=rest[j]; xt[g*G:(g+1)*G]=x[g*G:(g+1)*G]*cnt[j]*tot/(m*p[j])
                y+=Rm@xt
        out[i]=y
    return out
def rel(Yh): return np.sqrt(((Yh-Y)**2).sum()/ref2)
sub=slice(0,len(Xe),4); Xs=Xe[sub]; Ys=Y[sub]; ref2s=(Ys*Ys).sum()
def rels(Yh): return np.sqrt(((Yh-Ys)**2).sum()/ref2s)
# control variates
cvs={'none':None}
# output-space PCA (optimal rank-r for the calibration activations): C = U_r U_r^T W
Yc=Xc@W.T; U,_,_=np.linalg.svd(Yc.T,full_matrices=False)
for r in ranks: cvs[f'pca-r{r}']=U[:,:r]@(U[:,:r].T@W)
# diagonal (imatrix-style) low-rank, from calibration E[x^2]
s=np.sqrt((Xc*Xc).mean(0))+1e-6; u,sv,vt=np.linalg.svd(W*s,full_matrices=False)
#for r in ranks: cvs[f'diag-r{r}']=(u[:,:r]*sv[:r])@(vt[:r]/s)
print(f'{name} {N}x{K} {t.tensor_type.name}, groups={ng}, eval tokens={len(Xs)}')
for k,C in cvs.items():
    r=0 if C is None else int(k.split('-r')[1]); cvf=r*(N+K)*2/wbytes
    cap=0 if C is None else 1-(((Xe@(W-C).T)**2).sum()/ref2)
    row=f'  {k:9s} cv_bytes={cvf:5.1%} captures={cap:6.1%} |'
    for b in budgets:
        e=round(b*0.3,4)
        row+=f' b={b}: zeros {rels(est(Xs,C,b,e,False)):.3f} mc {rels(est(Xs,C,b,e)):.3f} |'
    print(row, flush=True)
# temporal delta CV (oracle: exact W x_prev known), within 512-token sequences
D=Xe.copy(); prev=np.roll(Xe,1,axis=0); first=(np.arange(len(Xe))%512)==0
dl=Xe-prev; dl[first]=Xe[first]
print(f'  delta-prev: ||W(x_t-x_t-1)||/||W x_t|| = {np.sqrt(((dl@W.T)**2).sum()/ref2):.3f}')
