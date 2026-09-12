'use client'

export interface PlaceItem {
  id: string
  name: string
  address: string | null
  category: string | null
  avgPrice: number | null
  note: string | null
  orderIndex: number
  lng: string | number
  lat: string | number
}

export default function PlaceCard({
  place,
  index,
  onNavigate,
  onDelete,
}: {
  place: PlaceItem
  index: number
  onNavigate: (id: string) => void
  onDelete?: (id: string) => void
}) {
  return (
    <div className="flex items-start gap-3 bg-white rounded-xl border border-gray-200 p-3">
      <span className="w-6 h-6 rounded-full bg-orange-500 text-white text-xs flex items-center justify-center shrink-0 mt-0.5">
        {index + 1}
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{place.name}</p>
        <p className="text-xs text-gray-400 truncate">{place.address || place.category || ''}</p>
        {place.avgPrice ? <p className="text-xs text-orange-600 mt-0.5">人均 ¥{place.avgPrice}</p> : null}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={() => onNavigate(place.id)} className="text-xs px-2.5 py-1 rounded-lg bg-orange-500 text-white">
          导航
        </button>
        {onDelete && (
          <button onClick={() => onDelete(place.id)} className="text-xs px-2 py-1 rounded-lg text-gray-400 hover:text-red-500">
            删除
          </button>
        )}
      </div>
    </div>
  )
}
