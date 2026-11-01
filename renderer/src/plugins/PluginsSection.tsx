/**
 * Settings section for the processing-node plugin interface (interface only).
 *
 * Lane F1 mounts this component; it owns its own loading and error handling and
 * never touches the canvas. It lists the plugins directory, asks the host to
 * load what it finds, and shows each plugin's declared processors. Nothing
 * here runs a processor: that action arrives in a later phase.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageBoardApi, PluginListing } from "../../../shared/image-board";
import { portTypeName, qualifiedProcessorId } from "../../../shared/processor-plugin";
import type { PortSpec, ProcessorDescriptor } from "../../../shared/processor-plugin";
import { getPluginHost } from "./plugin-host";
import type { PluginStatus } from "./plugin-host";
import "./plugins.css";

function PortList({ label, ports }: { label: string; ports: PortSpec[] }) {
  return (
    <div className="plg-ports">
      <span className="plg-ports-label">{label}</span>
      {ports.length === 0 ? (
        <span className="plg-ports-empty">无</span>
      ) : (
        ports.map((port) => {
          const typeLabel = portTypeName(port.type);
          return (
            <span key={port.id} className={`plg-port plg-port-${port.type}`}>
              {port.label}
              {port.label === typeLabel ? null : <small>· {typeLabel}</small>}
              {port.multiple ? <small>多值</small> : null}
            </span>
          );
        })
      )}
    </div>
  );
}

function ProcessorRow({ pluginId, processor }: { pluginId: string; processor: ProcessorDescriptor }) {
  return (
    <li className="plg-processor">
      <div className="plg-processor-head">
        <strong>{processor.title}</strong>
        <code>{qualifiedProcessorId(pluginId, processor.id)}</code>
      </div>
      {processor.description ? <p className="plg-processor-note">{processor.description}</p> : null}
      <div className="plg-processor-ports">
        <PortList label="输入" ports={processor.inputs} />
        <PortList label="输出" ports={processor.outputs} />
      </div>
    </li>
  );
}

export function PluginsSection(): JSX.Element {
  const [directory, setDirectory] = useState("");
  const [listingErrors, setListingErrors] = useState<PluginListing["errors"]>([]);
  const [statuses, setStatuses] = useState<PluginStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    const bridge = window.imageBoard as ImageBoardApi | undefined;
    if (typeof bridge?.listPlugins !== "function") {
      setFailure("当前宿主未提供插件目录接口");
      setStatuses([]);
      return;
    }
    setBusy(true);
    setFailure("");
    try {
      const listing = await bridge.listPlugins();
      if (!mountedRef.current) return;
      setDirectory(listing.directory);
      setListingErrors(listing.errors);
      const loaded = await getPluginHost().load(listing.plugins);
      if (mountedRef.current) setStatuses(loaded);
    } catch (caught) {
      if (mountedRef.current) setFailure(caught instanceof Error ? caught.message : "插件加载失败");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => {
      mountedRef.current = false;
    };
  }, [reload]);

  return (
    <section className="settings-section plg-section" aria-label="插件（处理节点接口预览）">
      <div className="settings-section-heading">
        <div>
          <strong>插件（处理节点接口预览）</strong>
          <span>这个版本只加载插件、显示它们声明的处理节点，还不能运行。</span>
        </div>
        <button type="button" className="plg-reload" onClick={() => void reload()} disabled={busy}>
          {busy ? "加载中…" : "重新加载"}
        </button>
      </div>

      <p className="plg-directory">
        <span>插件目录</span>
        <code>{directory || "读取中…"}</code>
      </p>

      {failure ? <p className="plg-error" role="alert">{failure}</p> : null}

      {listingErrors.length > 0 ? (
        <ul className="plg-errors" aria-label="插件读取错误">
          {listingErrors.map((item) => (
            <li key={item.folder}>
              <code>{item.folder}</code>
              <span>{item.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {statuses.length === 0 ? (
        <div className="plg-empty">
          <p>把插件文件夹放进上面的目录，每个文件夹里放 manifest.json 和入口脚本。</p>
          <p>这个版本还不能运行处理节点。</p>
        </div>
      ) : (
        <ul className="plg-list" aria-label="已发现的插件">
          {statuses.map((plugin) => (
            <li key={plugin.folder} className={`plg-item plg-item-${plugin.status}`}>
              <div className="plg-item-head">
                <strong>{plugin.manifest?.name ?? plugin.folder}</strong>
                <span className="plg-version">
                  {plugin.manifest ? `v${plugin.manifest.version}` : "清单无效"}
                </span>
                <span className={`plg-status plg-status-${plugin.status}`}>
                  {plugin.status === "ready" ? "已加载" : "加载失败"}
                </span>
              </div>
              <p className="plg-folder">{plugin.folder}</p>
              {plugin.error ? <p className="plg-error" role="alert">{plugin.error}</p> : null}
              {plugin.processors.length > 0 ? (
                <ul className="plg-processors">
                  {plugin.processors.map((processor) => (
                    <ProcessorRow
                      key={processor.id}
                      pluginId={plugin.manifest?.id ?? plugin.folder}
                      processor={processor}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default PluginsSection;
