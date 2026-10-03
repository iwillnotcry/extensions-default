import {
    Chapter,
    ChapterDetails,
    ChapterProviding,
    ContentRating,
    HomePageSectionsProviding,
    HomeSection,
    HomeSectionType,
    MangaProviding,
    PagedResults,
    PartialSourceManga,
    Request,
    Response,
    SearchRequest,
    SearchResultsProviding,
    SourceInfo,
    SourceIntents,
    SourceManga
} from '@paperback/types'
import { CheerioAPI } from 'cheerio'

const BASE = 'https://readallcomics.com'

export const ReadAllComicsInfo: SourceInfo = {
    version: '1.0.0',
    name: 'ReadAllComics',
    description: 'Extension that pulls comics from readallcomics.com',
    author: 'iwillnotcry',
    authorWebsite: 'https://github.com/iwillnotcry',
    icon: 'icon.png',
    contentRating: ContentRating.EVERYONE,
    websiteBaseURL: BASE,
    sourceTags: [],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS
}

export class ReadAllComics implements ChapterProviding, MangaProviding, SearchResultsProviding, HomePageSectionsProviding {
    constructor(private cheerio: CheerioAPI) {}

    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    'user-agent': await this.requestManager.getDefaultUserAgent(),
                    'referer': `${BASE}/`
                }
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => response
        }
    })

    // ---------- helpers ----------

    private async fetchHtml(url: string): Promise<CheerioAPI> {
        const request = App.createRequest({ url, method: 'GET' })
        const response = await this.requestManager.schedule(request, 1)
        if (response.status >= 400) {
            throw new Error(`Request to ${url} failed with status ${response.status}`)
        }
        return this.cheerio.load(response.data as string)
    }

    private categoryId(href: string): string {
        const match = /\/category\/([^/?#]+)/.exec(href)
        return match?.[1] ?? ''
    }

    private singleSlug(href: string): string {
        const path = href.replace(BASE, '').split(/[?#]/)[0] ?? ''
        const parts = path.split('/').filter(p => p.length > 0)
        return parts.length === 1 ? (parts[0] ?? '') : ''
    }

    private parseChapterNumber(name: string, fallback: number): number {
        const cleaned = name.replace(/\((19|20)\d{2}\)/g, '').replace(/\b(19|20)\d{2}\b/g, '')
        const numbers = cleaned.match(/\d+(?:\.\d+)?/g)
        if (!numbers || numbers.length === 0) return fallback
        const last = numbers[numbers.length - 1]
        if (last === undefined) return fallback
        const value = parseFloat(last)
        return isNaN(value) ? fallback : value
    }

    private parseSeries($: CheerioAPI): PartialSourceManga[] {
        const seen = new Set<string>()
        const results: PartialSourceManga[] = []

        $('a[href*="/category/"]').each((_, el) => {
            const href = $(el).attr('href') ?? ''
            const id = this.categoryId(href)
            const title = ($(el).text().trim() || $(el).attr('title') || '').trim()
            if (!id || !title || seen.has(id)) return
            seen.add(id)

            const image = $(el).find('img').attr('src') ?? ''
            results.push(App.createPartialSourceManga({
                mangaId: id,
                image,
                title,
                subtitle: undefined
            }))
        })

        return results
    }

    // ---------- MangaProviding ----------

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const $ = await this.fetchHtml(`${BASE}/category/${mangaId}/`)

        const title =
            $('.description-archive h1').first().text().trim() ||
            $('h1').first().text().trim() ||
            ($('meta[property="og:title"]').attr('content') ?? mangaId)

        const image =
            $('.description-archive img').first().attr('src') ??
            $('meta[property="og:image"]').attr('content') ??
            ''

        const desc = $('.description-archive p').text().trim()

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [title],
                image,
                status: 'Ongoing',
                author: '',
                artist: '',
                tags: [],
                desc
            })
        })
    }

    // ---------- ChapterProviding ----------

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const $ = await this.fetchHtml(`${BASE}/category/${mangaId}/`)
        const chapters: Chapter[] = []
        const seen = new Set<string>()

        let links = $('.list-story a')
        if (links.length === 0) {
            // fallback: any single-level link on the page that looks like a chapter
            const firstWord = mangaId.split('-')[0] ?? ''
            links = $('a[href]').filter((_, el) => {
                const href = $(el).attr('href') ?? ''
                const slug = this.singleSlug(href)
                return slug.length > 0 && slug.startsWith(firstWord) && !href.includes('/category/')
            })
        }

        links.each((_, el) => {
            const href = $(el).attr('href') ?? ''
            const id = this.singleSlug(href)
            const name = ($(el).text().trim() || $(el).attr('title') || id).trim()
            if (!id || seen.has(id)) return
            seen.add(id)

            chapters.push(App.createChapter({
                id,
                name,
                langCode: '🇬🇧',
                chapNum: this.parseChapterNumber(name, 0),
                time: new Date()
            }))
        })

        // if the numbers could not be detected, number them by position (oldest = 1)
        if (chapters.length > 0 && chapters.every(c => c.chapNum === 0)) {
            const total = chapters.length
            return chapters.map((c, i) => App.createChapter({
                id: c.id,
                name: c.name,
                langCode: c.langCode,
                chapNum: total - i,
                time: c.time
            }))
        }

        return chapters
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const $ = await this.fetchHtml(`${BASE}/${chapterId}/`)

        const isImage = (src: string): boolean =>
            /\.(jpe?g|png|webp|gif)(\?.*)?$/i.test(src) && !/logo|banner|avatar|gravatar|favicon|icon/i.test(src)

        const collect = (selector: string): string[] => {
            const pages: string[] = []
            $(selector).each((_, el) => {
                const src = ($(el).attr('src') ?? $(el).attr('data-src') ?? '').trim()
                if (src && isImage(src) && !pages.includes(src)) pages.push(src)
            })
            return pages
        }

        let pages = collect('.separator img, center img')
        if (pages.length === 0) pages = collect('body img')

        return App.createChapterDetails({
            id: chapterId,
            mangaId,
            pages
        })
    }

    // ---------- SearchResultsProviding ----------

    async getSearchResults(query: SearchRequest, _metadata: unknown): Promise<PagedResults> {
        const text = encodeURIComponent(query.title ?? '')
        const $ = await this.fetchHtml(`${BASE}/?story=${text}&s=&type=comic`)

        return App.createPagedResults({
            results: this.parseSeries($),
            metadata: undefined
        })
    }

    // ---------- HomePageSectionsProviding ----------

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const section = App.createHomeSection({
            id: 'all',
            title: 'Comics',
            containsMoreItems: false,
            type: HomeSectionType.singleRowNormal
        })
        sectionCallback(section)

        const $ = await this.fetchHtml(`${BASE}/`)
        section.items = this.parseSeries($)
        sectionCallback(section)
    }

    async getViewMoreItems(_homepageSectionId: string, _metadata: unknown): Promise<PagedResults> {
        return App.createPagedResults({ results: [], metadata: undefined })
    }
}       
