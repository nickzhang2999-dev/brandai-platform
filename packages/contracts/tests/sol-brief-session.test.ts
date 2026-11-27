import { describe, expect, it } from "vitest";
import { SolPosterConfirm, SolPosterInput } from "../src/sol-poster-brief";

const request = {mutationId:"11111111-1111-4111-8111-111111111111",contextRevision:0,documentRevision:1,
  target:{shapeId:"shape:test",assetSha256:"a".repeat(64)}};
const direction={appearance:"轮廓留白",scene:"纯色摄影背景",detail:"引线标注"};

describe("poster conversation input",()=>{
  it("accepts only a saved brief and the selected canvas version for approval",()=>{
    const confirmation={action:"confirm-appearance",briefId:"spb_"+"a".repeat(64),target:request.target,
      documentRevision:2,contextRevision:0};
    expect(SolPosterConfirm.parse(confirmation)).toEqual(confirmation);
    for (const extra of [{prompt:"other"},{assetId:"another"},{copies:3},{mutationId:request.mutationId}])
      expect(SolPosterConfirm.safeParse({...confirmation,...extra}).success).toBe(false);
  });
  it("reads pre-session requests and accepts explicit composition choices",()=>{
    expect(SolPosterInput.parse(request)).toEqual(request);
    expect(SolPosterInput.parse({...request,conversation:{message:"沿用构图",direction}}).conversation?.direction).toEqual(direction);
  });
  it("separates portable design choices from product facts and runtime identity",()=>{
    for(const conversation of [{message:"继续",direction:{...direction,approvedCopy:"old product"}},
      {message:"继续",sessionId:"client supplied"}, {message:"继续",parentId:"foreign"}]){
      expect(SolPosterInput.safeParse({...request,conversation}).success).toBe(false);
    }
  });
});
