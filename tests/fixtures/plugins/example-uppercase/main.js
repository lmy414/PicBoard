// Test-only plugin: uppercases text values (links use the URL) and appends the
// "suffix" parameter. Never shipped with the app.
picboard.registerProcessor({
  id: "uppercase",
  title: "转为大写",
  description: "把输入的文本转为大写，并追加后缀参数。",
  inputs: [{ id: "text", label: "文本", type: "text" }],
  outputs: [{ id: "text", label: "文本", type: "text" }],
  params: [{ id: "suffix", label: "后缀", type: "string", default: "" }],
  run(request) {
    const suffix = request.params.suffix;
    const values = request.inputs.text || [];
    return {
      outputs: {
        text: values.map((value) => ({
          type: "text",
          text: (value.type === "link" ? value.url : value.text).toUpperCase() + suffix,
        })),
      },
    };
  },
});
