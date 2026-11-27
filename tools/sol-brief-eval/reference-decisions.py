"""Exercise the shipping planner on 12 synthetic briefs against a loopback text model."""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "ai"))
from app.sol_poster_brief import PosterInput, plan_poster
from app.providers.http_providers import HttpVLMProvider

CASES = [
    ("窄岸线", "去年的夏季橱窗活动是这次新品海报的参考，请找出来。", "campaign", 2025),
    ("窄岸线", "想沿用以前的开学季活动，你先帮我找有哪些。", "campaign", None),
    ("窄岸线", "找本品牌去年的极光计划给我参考。", "campaign", 2025),
    ("窄岸线", "借鉴春季历史活动的风格，不要使用旧口号。", "campaign", None),
    ("窄岸线", "我想找外部纸雕风格案例用于新品海报。", "inspiration", None),
    ("窄岸线", "把新品放右边，保留原色，只用当前项目资料。", None, None),
    ("方隅", "帮我找二〇二五年的夏季活动，为新品做海报。", "campaign", 2025),
    ("方隅", "翻一下品牌以前的城市系列活动，我想选一款。", "campaign", None),
    ("方隅", "找我们品牌以往的星河项目作参考。", "campaign", None),
    ("方隅", "以前的冬季活动可以借鉴，只印这次确认的文案。", "campaign", None),
    ("方隅", "从灵感库帮我找留白构图的案例。", "inspiration", None),
    ("方隅", "改为左边留白，风扇颜色保留，只用这次上传的商品。", None, None),
]

async def run():
    provider=HttpVLMProvider("http://127.0.0.1:26483/v1","loopback-only",model="sol-local")
    records=[]
    for i,(brand,question,kind,year) in enumerate(CASES,1):
        data=PosterInput(product="自制样品",brand=brand,goal="新品海报",audience="通勤人群",rules=[],
            visualRequirements="",approvedCopy="新品上市",referencePlanning=True,referenceDate="2026-11-27",
            designNotes=question,providerRetryPolicy="never")
        row={"id":i,"brand":brand,"question":question,"expectedKind":kind,"expectedYear":year}
        try:
            result=await plan_poster(data,provider)
            pick=result.search
            row.update(search=pick.model_dump() if pick else None,passed=(pick.kind if pick else None)==kind and (pick.year if pick else None)==year)
        except Exception as e:
            row.update(error=type(e).__name__,passed=False)
        records.append(row)
        Path(sys.argv[1]).write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding="utf8")
        print(f"{i}/12: {row['passed']}",flush=True)
    return all(r["passed"] for r in records)

if __name__=="__main__":
    sys.exit(0 if asyncio.run(run()) else 1)
