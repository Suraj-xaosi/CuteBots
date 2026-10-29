"use client"

import { useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { createConversation, getConversation, listConversations, updateConversation } from "@/lib/actions/conversations"
import { replyToRun, submitMessage, cancelRun } from "@/lib/actions/runs"
import { listProjects } from "@/lib/actions/projects"
import { useProjectContext } from "@/components/project-provider"
import {
  AgentRunStatus,
  isActiveAgentRunStatus,
  type ActivityItem,
  type ConversationDetails,
  type ConversationItem,
} from "@workspace/types"
import { ChatPanel } from "./chat-panel"
import { ConversationSidebar } from "./conversation-sidebar"
import { FileDialog } from "./file-dialog"
import { RunPanel } from "./run-panel"
import { connectRunStream } from "./run-stream"
import { Topbar } from "./topbar"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@workspace/ui/components/resizable"

export function Workspace({
  initialConversations,
  initialConversation,
  initialActivity,
  initialError,
}: {
  initialConversations: ConversationItem[]
  initialConversation: ConversationDetails | null
  initialActivity: ActivityItem[]
  initialError: string | null
}) {
  const {
    projects,
    selectedProjectId,
    activeConversationId,
    setActiveConversationId,
    selectProject,
    replaceProjects,
  } = useProjectContext()
  const [conversations, setConversations] = useState(initialConversations)
  const [conversation, setConversation] = useState(initialConversation)
  const [activities, setActivities] = useState(initialActivity)
  const [error, setError] = useState(initialError)
  const [filesOpen, setFilesOpen] = useState(false)
  const stream = useRef<EventSource | null>(null)
  const navigation = useRef(0)
  const busy = useMutation({
    mutationFn: ({ conversationId, content }: { conversationId: string; content: string }) =>
      submitMessage(conversationId, content),
    gcTime: 0,
  })
  const cancel = useMutation({
    mutationFn: cancelRun,
    gcTime: 0,
    onSuccess: (result, runId) => {
      if (!result.ok) setError(result.error)
      else setConversation((current) =>
        current?.runs[0]?.id === runId
          ? { ...current, runs: [{ ...current.runs[0], status: AgentRunStatus.INTERRUPTED }, ...current.runs.slice(1)] }
          : current
      )
    },
  })
  const project = projects.find((item) => item.id === selectedProjectId)
  const currentRun = conversation?.runs[0] ?? null

  const openRunStream = async (runId: string, requestId: number) => {
    stream.current?.close()
    const source = await connectRunStream(
      runId,
      () => requestId === navigation.current,
      setActivities,
      setConversation,
      setError
    )
    if (requestId === navigation.current) stream.current = source
    else source?.close()
  }

  const chooseConversation = async (item: ConversationItem) => {
    const requestId = ++navigation.current
    setError(null)
    stream.current?.close()
    setActiveConversationId(item.id)
    const result = await getConversation(item.id)
    if (requestId !== navigation.current) return
    if (!result.ok) {
      setError(result.error)
      return
    }
    setConversation(result.data)
    const current = result.data.runs[0]
    if (current && isActiveAgentRunStatus(current.status)) {
      await openRunStream(current.id, requestId)
    } else {
      setActivities([])
    }
  }

  const changeProject = async (id: string) => {
    const requestId = ++navigation.current
    setError(null)
    stream.current?.close()
    selectProject(id)
    setActiveConversationId(null)
    setConversations([])
    setConversation(null)
    setActivities([])
    const result = await listConversations(id)
    if (requestId !== navigation.current) return
    if (!result.ok) {
      setConversations([])
      setConversation(null)
      setError(result.error)
      return
    }
    setConversations(result.data)
    const first = result.data[0]
    if (!first) {
      setConversation(null)
      setActivities([])
      return
    }
    await chooseConversation(first)
  }

  const refreshProjectList = async () => {
    const result = await listProjects()
    if (!result.ok) {
      setError(result.error)
      return false
    }
    replaceProjects(result.data)
    return true
  }

  const projectCreated = async (id: string, setupError: string | null) => {
    const requestId = ++navigation.current
    stream.current?.close()
    const refreshed = await refreshProjectList()
    if (requestId !== navigation.current) return
    selectProject(id)
    setActiveConversationId(null)
    setConversations([])
    setConversation(null)
    setActivities([])
    if (setupError) setError(setupError)
    else if (refreshed) setError(null)
  }

  const reconnectRun = () => {
    if (!currentRun) return
    void openRunStream(currentRun.id, ++navigation.current)
  }

  const newConversation = async () => {
    if (!project) return
    const requestId = navigation.current
    const result = await createConversation(project.id)
    if (requestId !== navigation.current) return
    if (!result.ok) {
      setError(result.error)
      return
    }
    setConversations((current) => [result.data, ...current])
    setConversation({ ...result.data, messages: [], runs: [] })
    setActiveConversationId(result.data.id)
    setActivities([])
    setError(null)
  }

  const sendMessage = async (content: string) => {
    if (!conversation || !project) return false
    const requestId = navigation.current
    setError(null)
    if (currentRun?.status === AgentRunStatus.WAITING_FOR_INPUT) {
      const result = await replyToRun(currentRun.id, content)
      if (requestId !== navigation.current) return result.ok
      if (!result.ok) {
        setError(result.error)
        const refreshed = await getConversation(conversation.id)
        if (requestId === navigation.current && refreshed.ok) {
          setConversation(refreshed.data)
          setConversations((current) => current.map((item) =>
            item.id === conversation.id
              ? { ...item, messageCount: refreshed.data.messages.length }
              : item
          ))
        }
        return false
      }
      setConversation((current) => current ? {
        ...current,
        runs: [{ ...currentRun, status: AgentRunStatus.RUNNING }, ...current.runs.slice(1)],
        messages: [...current.messages, {
          id: `reply-${Date.now()}`,
          role: "user",
          content,
          runId: currentRun.id,
          createdAt: new Date(),
        }],
      } : current)
      return true
    }

    const result = await busy.mutateAsync({ conversationId: conversation.id, content })
    if (requestId !== navigation.current) return result.ok
    if (!result.ok) {
      setError(result.error)
      const refreshed = await getConversation(conversation.id)
      if (requestId === navigation.current && refreshed.ok) {
        setConversation(refreshed.data)
        setConversations((current) => current.map((item) =>
          item.id === conversation.id
            ? { ...item, messageCount: refreshed.data.messages.length }
            : item
        ))
      }
      return false
    }
    const title = conversation.title || content.slice(0, 48)
    if (!conversation.title) {
      const updated = await updateConversation(conversation.id, title)
      if (requestId !== navigation.current) return true
      if (!updated.ok) setError(updated.error)
      else setConversations((current) => current.map((item) =>
        item.id === conversation.id ? { ...item, title } : item
      ))
    }
    const refreshed = await getConversation(conversation.id)
    if (requestId !== navigation.current) return true
    if (refreshed.ok) {
      setConversation(refreshed.data)
      setConversations((current) => current.map((item) =>
        item.id === conversation.id
          ? { ...item, messageCount: refreshed.data.messages.length, latestRun: refreshed.data.runs[0] }
          : item
      ))
      const runId = refreshed.data.runs[0]?.id
      if (runId) await openRunStream(runId, requestId)
    } else setError(refreshed.error)
    return true
  }

  return (
    <Card className="h-dvh overflow-hidden rounded-none border-0 py-0">
      <Topbar onProjectChange={changeProject} onProjectCreated={projectCreated} />
      <CardContent className="h-[calc(100dvh-4rem)] min-h-0 p-0">
        {project ? (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0">
            <ResizablePanel defaultSize={21} minSize={14} collapsible collapsedSize={0}>
              <ConversationSidebar
                conversations={conversations}
                selectedId={activeConversationId}
                disabled={false}
                onCreate={() => void newConversation()}
                onSelect={(item) => void chooseConversation(item)}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={54} minSize={30}>
              <ChatPanel
                conversation={conversation}
                pending={busy.isPending}
                error={error}
                onSend={sendMessage}
                onOpenFiles={() => setFilesOpen(true)}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={25} minSize={16} collapsible collapsedSize={0}>
              <RunPanel
                runs={conversation?.runs ?? []}
                activities={activities}
                sandboxStatus={project.sandboxStatus}
                pending={cancel.isPending}
                onCancel={(runId) => cancel.mutate(runId)}
                onReconnect={reconnectRun}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <Card className="grid h-full place-items-center border-0 shadow-none">
            <CardHeader className="w-full max-w-lg px-6 text-center">
              <CardTitle className="text-2xl">Your coding workspace</CardTitle>
              <CardDescription>
                Add a GitHub project to create its sandbox and start a conversation with your agent.
              </CardDescription>
              {error ? <CardDescription className="text-destructive">{error}</CardDescription> : null}
            </CardHeader>
          </Card>
        )}
      </CardContent>
      {project ? (
        <FileDialog projectId={project.id} open={filesOpen} onOpenChange={setFilesOpen} />
      ) : null}
    </Card>
  )
}
