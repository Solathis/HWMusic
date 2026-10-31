/**
 * 设置「关于」：版本信息、技术栈、开源地址、参考项目。
 * 数据与文案在 `features/settings/about-info.mjs`；版本与运行环境问宿主，外链按键交宿主打开。
 */
import { useEffect, useState } from "react"
import { ExternalLinkIcon } from "lucide-react"

import { Button } from "./components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table"
import {
  ABOUT_INFO_FAILED,
  ABOUT_OPEN_FAILED,
  PROJECT_LINKS,
  REFERENCE_LINKS,
  TECH_STACK,
  runtimeRows,
  techVersionText,
} from "./features/settings/about-info.mjs"
import { getAppInfo, openLink, type AppInfo } from "./host-api"

interface AboutLink {
  key: string
  label: string
  url: string
  note?: string
}

function LinkList({
  links,
  failedKey,
  onOpen,
}: {
  links: AboutLink[]
  failedKey: string | null
  onOpen: (key: string) => void
}) {
  return (
    <ul className="flex flex-col gap-3">
      {links.map((link) => (
        <li key={link.key} className="flex flex-col gap-1">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium">
                {link.label}
                {link.note ? <span className="ml-2 font-normal text-muted-foreground">{link.note}</span> : null}
              </span>
              <span className="break-all text-xs text-muted-foreground">{link.url}</span>
            </div>
            <Button variant="outline" size="sm" aria-label={`打开${link.label}`} onClick={() => onOpen(link.key)}>
              <ExternalLinkIcon data-icon="inline-start" />
              打开
            </Button>
          </div>
          {failedKey === link.key ? (
            <p className="text-sm text-destructive" role="alert">
              {ABOUT_OPEN_FAILED}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export function AboutPane() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [infoFailed, setInfoFailed] = useState(false)
  const [failedKey, setFailedKey] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getAppInfo()
      .then((answer) => {
        if (alive) setInfo(answer)
      })
      .catch(() => {
        if (alive) setInfoFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const open = (key: string) => {
    setFailedKey(null)
    openLink(key).catch(() => setFailedKey(key))
  }

  return (
    <>
      <Card data-testid="about-info">
        <CardHeader>
          <CardTitle>版本信息</CardTitle>
          <CardDescription>第三方独立实现，以 AGPL-3.0-only 开源。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <dl className="flex flex-col gap-2 text-sm">
            {runtimeRows(info).map((row) => (
              <div key={row.id} className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="text-right font-medium" data-testid={`about-${row.id}`}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          {infoFailed ? (
            <p className="text-sm text-destructive" role="alert">
              {ABOUT_INFO_FAILED}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card data-testid="about-stack">
        <CardHeader>
          <CardTitle>技术栈</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>组件</TableHead>
                <TableHead>用途</TableHead>
                <TableHead className="text-right">版本</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TECH_STACK.map((entry) => (
                <TableRow key={entry.name}>
                  <TableCell className="font-medium">{entry.name}</TableCell>
                  <TableCell className="text-muted-foreground">{entry.role}</TableCell>
                  <TableCell className="text-right">{techVersionText(entry, info)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card data-testid="about-links">
        <CardHeader>
          <CardTitle>开源地址</CardTitle>
        </CardHeader>
        <CardContent>
          <LinkList links={PROJECT_LINKS} failedKey={failedKey} onOpen={open} />
        </CardContent>
      </Card>

      <Card data-testid="about-references">
        <CardHeader>
          <CardTitle>参考项目</CardTitle>
        </CardHeader>
        <CardContent>
          <LinkList links={REFERENCE_LINKS} failedKey={failedKey} onOpen={open} />
        </CardContent>
      </Card>
    </>
  )
}
