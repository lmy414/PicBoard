type RangeGeometry = {
  getClientRects?: () => DOMRectList;
  getBoundingClientRect?: () => DOMRect;
};

/** Supply jsdom's missing CSSOM Range methods while preserving test isolation. */
export function installRangeGeometry(): () => void {
  const proto = Range.prototype as unknown as RangeGeometry;
  const clientRects = proto.getClientRects;
  const boundingRect = proto.getBoundingClientRect;
  const zero = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 } as DOMRect;
  proto.getClientRects = () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect = () => zero;
  return () => {
    if (clientRects) proto.getClientRects = clientRects;
    else delete proto.getClientRects;
    if (boundingRect) proto.getBoundingClientRect = boundingRect;
    else delete proto.getBoundingClientRect;
  };
}
